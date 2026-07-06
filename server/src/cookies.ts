/**
 * Tock + OpenTable session-cookie storage and injection.
 *
 * Single responsibility: hold authenticated session cookies for each platform
 * in separate per-platform jars and get them onto a headless Playwright browser
 * so the sniper/booker acts as a logged-in user (skipping login, seeing member
 * pricing, holding a checkout session).
 *
 * Source of truth is a process-global per-platform cache (`jars`) backed by two
 * persistence layers, tried in this precedence order by {@link loadCookiesFromEnv}:
 *   1. Disk (`store.ts` state.json on the Railway /data volume) — the live,
 *      mutable copy that survives across requests within a single deploy and is
 *      overwritten whenever the dashboard UI pushes fresh cookies.
 *   2. The platform env var (base64-encoded JSON) — a seed/bootstrap value
 *      baked into the deploy; used only when disk has nothing, and copied to disk
 *      on first read so subsequent lookups hit the disk fast-path.
 *
 * Key exports:
 *   - {@link Platform}             — 'tock' | 'opentable'.
 *   - {@link TockCookie}           — the serialized cookie shape stored/transported.
 *   - {@link loadCookiesFromEnv}   — hydrate the cache from disk or env (call at boot).
 *   - {@link updateCookies}        — replace the cache (from UI) and persist to disk.
 *   - {@link getCookies}           — read the in-memory cache.
 *   - {@link injectCookies}        — push the cache into a Playwright context.
 */
import { BrowserContext } from 'playwright';
import { saveToDisk, loadFromDisk } from './store';

/** The platforms this server manages cookies for. */
export type Platform = 'tock' | 'opentable';

/**
 * Serialized session cookie.
 *
 * Mirrors the subset of Playwright's cookie shape we persist to disk / accept
 * from the dashboard UI. Only `name`/`value` are mandatory; the rest are
 * optional because captured/pasted cookies often omit them, so
 * {@link injectCookies} fills empirically-safe defaults per platform.
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

const DISK_KEY: Record<Platform, string> = { tock: 'cookies', opentable: 'opentableCookies' };
const ENV_VAR: Record<Platform, string> = { tock: 'TOCK_COOKIES', opentable: 'OPENTABLE_COOKIES' };
const DEFAULT_DOMAIN: Record<Platform, string> = { tock: '.exploretock.com', opentable: '.opentable.com' };

/** Per-platform in-memory cookie jars. */
const jars: Record<Platform, TockCookie[]> = { tock: [], opentable: [] };

/**
 * Hydrate each platform's jar from persistence.
 *
 * Precedence per platform: disk wins over the env seed (disk holds any cookies
 * the dashboard has since pushed; env is only the deploy-time bootstrap). On the
 * env fallback path the decoded cookies are written straight to disk so the next
 * call takes the disk fast-path.
 *
 * Env vars are base64-encoded JSON (base64 keeps the JSON blob a single
 * env-safe token). Malformed input is swallowed and treated as "no cookies"
 * rather than crashing boot — the sniper can still run unauthenticated.
 */
export function loadCookiesFromEnv(): void {
  (['tock', 'opentable'] as Platform[]).forEach((p) => {
    const fromDisk = loadFromDisk(DISK_KEY[p] as any);
    if (Array.isArray(fromDisk) && fromDisk.length > 0) {
      jars[p] = fromDisk;
      console.log(`🍪 Loaded ${jars[p].length} ${p} cookies from disk`);
      return;
    }
    const raw = process.env[ENV_VAR[p]];
    if (!raw) return;
    try {
      jars[p] = JSON.parse(Buffer.from(raw, 'base64').toString('utf-8'));
      saveToDisk(DISK_KEY[p] as any, jars[p]);
    } catch (err) {
      console.error(`Failed to parse ${ENV_VAR[p]}:`, err);
    }
  });
}

/**
 * Replace the platform's jar with UI-supplied cookies and persist to disk.
 *
 * Full replacement (not a merge): the dashboard sends the complete cookie set,
 * so stale cookies dropped by the browser must not linger. Defaults to `'tock'`
 * for back-compat with all existing Tock call sites.
 */
export function updateCookies(cookies: TockCookie[], platform: Platform = 'tock'): void {
  jars[platform] = cookies;
  saveToDisk(DISK_KEY[platform] as any, cookies);
}

/** Read the in-memory cookie jar for the given platform (defaults to `'tock'`). */
export function getCookies(platform: Platform = 'tock'): TockCookie[] {
  return jars[platform];
}

/**
 * Inject the cached cookies for a platform into a fresh Playwright browser context.
 *
 * Returns the number of cookies added so callers can log/verify the context is
 * actually authenticated. Returns 0 (no-op) when the jar is empty so the
 * caller can fall back to interactive login instead of running signed-out.
 *
 * Each optional {@link TockCookie} field is coerced to a platform-appropriate
 * default, because pasted/captured cookies routinely omit metadata that Playwright
 * requires. Defaults to `'tock'` for back-compat with all existing Tock call sites.
 */
export async function injectCookies(context: BrowserContext, platform: Platform = 'tock'): Promise<number> {
  const stored = jars[platform];
  if (stored.length === 0) return 0;

  const playwrightCookies = stored.map((c) => ({
    name: c.name,
    value: c.value,
    domain: c.domain || DEFAULT_DOMAIN[platform],
    path: c.path || '/',
    httpOnly: c.httpOnly ?? false,
    secure: c.secure ?? true,
    sameSite: (c.sameSite as 'Strict' | 'Lax' | 'None') || 'Lax',
    expires: c.expires || Math.floor(Date.now() / 1000) + 86400,
  }));

  await context.addCookies(playwrightCookies);
  return playwrightCookies.length;
}
