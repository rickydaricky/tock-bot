import { getCookies } from './cookies';
import { loginToTock } from './login';
import { saveToDisk, loadFromDisk } from './store';

const REFRESH_INTERVAL_MS = 12 * 60 * 60 * 1000; // 12 hours
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
    const cookieHeader = cookies.map(c => `${c.name}=${c.value}`).join('; ');
    const res = await fetch(VALIDATION_URL, {
      headers: {
        'Cookie': cookieHeader,
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
      },
      redirect: 'manual',
    });

    // 200 = authenticated, 401/302 = expired
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

/** Start periodic session refresh (every 12 hours) */
export function startSessionRefresh(): void {
  // Check on startup (after a short delay to let the server start)
  setTimeout(async () => {
    await ensureValidSession();
  }, 5000);

  // Then check every 12 hours
  setInterval(async () => {
    console.log('\n🔄 Periodic session check...');
    await ensureValidSession();
  }, REFRESH_INTERVAL_MS);

  console.log(`🔄 Session auto-refresh enabled (every ${REFRESH_INTERVAL_MS / 3600000}h)`);
}
