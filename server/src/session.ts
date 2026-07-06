/**
 * session.ts — Tock login session lifecycle for the headless booking server.
 *
 * Single responsibility: keep a *valid* set of Tock session cookies alive so the
 * sniper/booker can act as the logged-in patron without a human re-authenticating.
 * It does this by (a) persisting the raw Tock email/password to disk so the server
 * can re-login unattended, and (b) periodically probing whether the current cookies
 * still authenticate, auto-refreshing via a full login when they don't.
 *
 * Where it sits in the system: this is the auth-keepalive layer beneath the booking
 * engine. `cookies.ts` owns the cookie jar, `login.ts` performs the actual browser
 * login (and writes fresh cookies), and this file orchestrates *when* to log in.
 * `index.ts` calls `startSessionRefresh()` once at boot; the sniper/booker call
 * `ensureValidSession()` before an attempt to fail fast on a dead session.
 *
 * SECURITY NOTE: credentials are stored in plaintext via `store.ts` (disk at /data).
 * This is a deliberate tradeoff — unattended re-login is impossible without the raw
 * password — but it means the persistence location must be treated as a secret.
 *
 * Key exports:
 *  - saveTockCredentials() / getTockCredentials() — persist & read the login used for auto-refresh
 *  - ensureValidSession() — validate-then-relogin; the guard callers run before booking
 *  - startSessionRefresh() — install the boot-time + 12h periodic keepalive timers
 */

import { getCookies } from './cookies';
import { loginToTock } from './login';
import { saveToDisk, loadFromDisk } from './store';

// How often the background keepalive re-checks the session. 12h is well inside
// Tock's cookie lifetime, so a refresh normally happens long before expiry.
const REFRESH_INTERVAL_MS = 12 * 60 * 60 * 1000; // 12 hours
// Lightweight authenticated endpoint used as a liveness probe: it returns 200 only
// when the request carries valid patron cookies, so its status code doubles as an
// "am I still logged in?" signal without side effects.
const VALIDATION_URL = 'https://www.exploretock.com/api/consumer/patron/profile';

/** Save Tock credentials to disk for auto-refresh */
export function saveTockCredentials(email: string, password: string): void {
  saveToDisk('tockCredentials', { email, password });
}

/** Get saved Tock credentials */
export function getTockCredentials(): { email: string; password: string } | null {
  return loadFromDisk('tockCredentials') as { email: string; password: string } | null;
}

/**
 * Check if current cookies are valid by hitting Tock's patron profile API.
 * Returns true if authenticated, false if cookies are expired/invalid.
 */
async function validateCookies(): Promise<boolean> {
  const cookies = getCookies();
  if (cookies.length === 0) return false;

  try {
    // Rebuild a raw `Cookie:` header from the jar rather than relying on a cookie-aware
    // client — this fetch is a bare probe with no persistent cookie store of its own.
    const cookieHeader = cookies.map(c => `${c.name}=${c.value}`).join('; ');
    const res = await fetch(VALIDATION_URL, {
      headers: {
        'Cookie': cookieHeader,
        // Spoof a real desktop browser UA; Tock's edge rejects/challenges default
        // fetch/undici UAs, which would produce false "expired" readings.
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
      },
      // `manual` is load-bearing: an expired session responds with a 302 redirect to the
      // login page. Without this, fetch would follow it and surface a 200 from the login
      // page, masking the expiry. Keeping the redirect raw lets us treat 302 as "expired".
      redirect: 'manual',
    });

    // 200 = authenticated. Anything else (401 unauthorized, 302 redirect-to-login) = expired.
    const valid = res.status === 200;
    console.log(`🍪 Cookie validation: ${valid ? 'valid' : 'expired'} (status ${res.status})`);
    return valid;
  } catch (err) {
    console.error('🍪 Cookie validation error:', err);
    return false;
  }
}

/**
 * Ensure we have valid cookies. If not, auto-login with saved credentials.
 * Returns true if we have valid cookies after this call.
 */
export async function ensureValidSession(): Promise<boolean> {
  // Check if current cookies are valid
  const valid = await validateCookies();
  if (valid) return true;

  // Try auto-login with saved credentials
  const creds = getTockCredentials();
  if (!creds) {
    console.log('🔐 No saved Tock credentials — cannot auto-refresh session');
    return false;
  }

  console.log('🔄 Cookies expired, auto-refreshing via login...');
  const result = await loginToTock(creds.email, creds.password);
  return result.success;
}

/**
 * Install the background session keepalive: one deferred check at boot plus a
 * recurring check every REFRESH_INTERVAL_MS. Call exactly once during server
 * startup (from index.ts). Fire-and-forget by design — failures are logged, not
 * thrown, so a dead session never crashes the process; callers still gate on
 * ensureValidSession() before an actual booking attempt.
 */
export function startSessionRefresh(): void {
  // Defer the first check ~5s so it doesn't race server startup (cookies/creds may
  // still be loading from disk, and the network stack should be up first).
  setTimeout(async () => {
    await ensureValidSession();
  }, 5000);

  // Steady-state keepalive: revalidate (and relogin if needed) on the fixed interval.
  setInterval(async () => {
    console.log('\n🔄 Periodic session check...');
    await ensureValidSession();
  }, REFRESH_INTERVAL_MS);

  console.log(`🔄 Session auto-refresh enabled (every ${REFRESH_INTERVAL_MS / 3600000}h)`);
}
