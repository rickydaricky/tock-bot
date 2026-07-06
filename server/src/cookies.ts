/**
 * Tock session-cookie storage and injection.
 *
 * Single responsibility: hold the authenticated Tock session cookies in one
 * place and get them onto a headless Playwright browser so the sniper/booker
 * act as a logged-in user (skipping login, seeing member pricing, holding a
 * checkout session).
 *
 * Source of truth is a process-global cache (`storedCookies`) backed by two
 * persistence layers, tried in this precedence order by {@link loadCookiesFromEnv}:
 *   1. Disk (`store.ts` state.json on the Railway /data volume) — the live,
 *      mutable copy that survives across requests within a single deploy and is
 *      overwritten whenever the dashboard UI pushes fresh cookies.
 *   2. The `TOCK_COOKIES` env var (base64-encoded JSON) — a seed/bootstrap value
 *      baked into the deploy; used only when disk has nothing, and copied to disk
 *      on first read so subsequent lookups hit the disk fast-path.
 *
 * Key exports:
 *   - {@link TockCookie}          — the serialized cookie shape stored/transported.
 *   - {@link loadCookiesFromEnv}  — hydrate the cache from disk or env (call at boot).
 *   - {@link updateCookies}       — replace the cache (from UI) and persist to disk.
 *   - {@link getCookies}          — read the in-memory cache.
 *   - {@link injectCookies}       — push the cache into a Playwright context.
 */
import { BrowserContext } from 'playwright';
import { saveToDisk, loadFromDisk } from './store';

/**
 * Serialized Tock session cookie.
 *
 * Mirrors the subset of Playwright's cookie shape we persist to disk / accept
 * from the dashboard UI. Only `name`/`value` are mandatory; the rest are
 * optional because captured/pasted cookies often omit them, so
 * {@link injectCookies} fills empirically-safe defaults for Tock.
 */
export interface TockCookie {
  name: string;
  value: string;
  domain: string;
  path: string;
  httpOnly?: boolean;
  secure?: boolean;
  sameSite?: 'Strict' | 'Lax' | 'None';
  expires?: number;
}

/**
 * Process-global in-memory cache of the current session cookies.
 *
 * This is the single source read by {@link getCookies}/{@link injectCookies};
 * disk and env are only ever used to (re)hydrate it. Every mutating path also
 * writes through to disk so the cache and persisted state never diverge.
 */
let storedCookies: TockCookie[] = [];

/**
 * Hydrate {@link storedCookies} from persistence and return it.
 *
 * Precedence: disk wins over the env seed, because disk holds any cookies the
 * dashboard has since pushed (env is only the deploy-time bootstrap). On the
 * env fallback path the decoded cookies are written straight to disk so the next
 * call takes the disk fast-path and the seed never has to be re-decoded.
 *
 * `TOCK_COOKIES` is base64-encoded JSON (base64 keeps the JSON blob a single
 * env-safe token). Malformed input is swallowed and treated as "no cookies"
 * rather than crashing boot — the sniper can still run unauthenticated.
 */
export function loadCookiesFromEnv(): TockCookie[] {
  // Try disk first (persists across requests within a deploy)
  const fromDisk = loadFromDisk('cookies');
  if (Array.isArray(fromDisk) && fromDisk.length > 0) {
    storedCookies = fromDisk;
    console.log(`🍪 Loaded ${storedCookies.length} cookies from disk`);
    return storedCookies;
  }

  // Fall back to env var
  const raw = process.env.TOCK_COOKIES;
  if (!raw) return [];

  try {
    const json = Buffer.from(raw, 'base64').toString('utf-8');
    storedCookies = JSON.parse(json);
    saveToDisk('cookies', storedCookies);
    return storedCookies;
  } catch (err) {
    console.error('Failed to parse TOCK_COOKIES:', err);
    return [];
  }
}

/**
 * Replace the cache with UI-supplied cookies and persist to disk.
 *
 * Full replacement (not a merge): the dashboard sends the complete cookie set,
 * so stale cookies dropped by the browser must not linger. The disk write makes
 * the update outlive the current request.
 */
export function updateCookies(cookies: TockCookie[]): void {
  storedCookies = cookies;
  saveToDisk('cookies', cookies);
}

/** Read the in-memory cookie cache (see {@link storedCookies}). */
export function getCookies(): TockCookie[] {
  return storedCookies;
}

/**
 * Inject the cached cookies into a fresh Playwright browser context.
 *
 * Returns the number of cookies added so callers can log/verify the context is
 * actually authenticated. Returns 0 (no-op) when the cache is empty so the
 * caller can fall back to interactive login instead of running signed-out.
 *
 * Each optional {@link TockCookie} field is coerced to a Tock-safe default,
 * because pasted/captured cookies routinely omit metadata that Playwright
 * requires:
 *   - `domain` → `.exploretock.com` (leading dot = valid on all subdomains).
 *   - `secure` defaults true and `sameSite` defaults `Lax` to match how Tock
 *     actually sets its session cookies.
 *   - `expires` → now + 86400s (24h) when absent, long enough to outlive a
 *     single drop/booking run without persisting indefinitely.
 */
export async function injectCookies(context: BrowserContext): Promise<number> {
  if (storedCookies.length === 0) return 0;

  const playwrightCookies = storedCookies.map(c => ({
    name: c.name,
    value: c.value,
    domain: c.domain || '.exploretock.com',
    path: c.path || '/',
    httpOnly: c.httpOnly ?? false,
    secure: c.secure ?? true,
    sameSite: c.sameSite as 'Strict' | 'Lax' | 'None' || 'Lax' as const,
    expires: c.expires || Math.floor(Date.now() / 1000) + 86400,
  }));

  await context.addCookies(playwrightCookies);
  return playwrightCookies.length;
}
