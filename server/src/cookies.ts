import { BrowserContext } from 'playwright';
import { saveToDisk, loadFromDisk } from './store';

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

let storedCookies: TockCookie[] = [];

/** Load cookies — tries disk first, then TOCK_COOKIES env var */
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

/** Update stored cookies (from UI) and persist to disk */
export function updateCookies(cookies: TockCookie[]): void {
  storedCookies = cookies;
  saveToDisk('cookies', cookies);
}

/** Get current stored cookies */
export function getCookies(): TockCookie[] {
  return storedCookies;
}

/** Inject stored cookies into a Playwright browser context */
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
