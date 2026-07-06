/**
 * login.ts — Playwright-driven Tock login that harvests a fresh session.
 *
 * Single responsibility: automate email/password sign-in on exploretock.com in a
 * real Chromium browser, then extract and persist the resulting session cookies so
 * the rest of the server (sniper/booker/API calls) can act as the logged-in user.
 *
 * Why a full browser instead of a plain HTTP POST: Tock gates its login behind
 * Cloudflare Turnstile, which requires executing the challenge's JS and looking
 * like a genuine browser — hence the stealth launch args, webdriver spoofing, and
 * the deliberate warm-up waits below. Cookies flow out via updateCookies() (cookies.ts).
 *
 * Key export: loginToTock(email, password) → { success, cookieCount?, error? }.
 */
import { chromium } from 'playwright';
import { updateCookies, TockCookie } from './cookies';

/**
 * Chromium flags that reduce automation fingerprinting so Cloudflare Turnstile is
 * more likely to auto-resolve.
 * - disable-blink-features=AutomationControlled: strips the flag that would otherwise
 *   set navigator.webdriver=true and trip bot detection.
 * - no-sandbox / disable-setuid-sandbox: required to launch Chromium as root inside
 *   the Railway/Docker container (no user namespace sandbox available there).
 */
const STEALTH_ARGS = [
  '--disable-blink-features=AutomationControlled',
  '--no-sandbox',
  '--disable-setuid-sandbox',
];

/**
 * Log into Tock with email/password via Playwright.
 * Extracts all cookies after successful login and stores them.
 * Returns the cookie count on success.
 *
 * Must run in headed mode on Railway to pass Cloudflare Turnstile.
 * On Railway, Xvfb (virtual display) is included in the Playwright Docker image.
 */
export async function loginToTock(email: string, password: string): Promise<{ success: boolean; cookieCount?: number; error?: string }> {
  let browser = null;

  try {
    console.log(`🔐 Logging into Tock as ${email}...`);

    browser = await chromium.launch({
      headless: true,
      args: STEALTH_ARGS,
    });

    const context = await browser.newContext({
      viewport: { width: 1440, height: 900 },
      userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    });

    const page = await context.newPage();
    // Belt-and-suspenders anti-detection: force navigator.webdriver to report false
    // before any page script runs, in case the launch flag alone leaves it truthy.
    // addInitScript re-injects this on every navigation/document in this page.
    await page.addInitScript(() => {
      Object.defineProperty((globalThis as any).navigator, 'webdriver', { get: () => false });
    });

    // Step 1: Navigate to login page (go via homepage to warm up Turnstile)
    console.log('   Navigating to login page...');
    await page.goto('https://www.exploretock.com/login', { waitUntil: 'domcontentloaded', timeout: 30000 });

    // Empirically Turnstile needs a few seconds of idle to run its JS challenge and
    // drop the clearance cookie; fill the form too early and the submit gets blocked.
    await page.waitForTimeout(5000);

    // Turnstile's interstitial ("Just a moment..." / Cloudflare) hijacks the tab title.
    // If we're still on it after the initial wait, block until the title changes back
    // (challenge cleared) rather than racing ahead and finding no login form.
    const title = await page.title();
    if (title.includes('moment') || title.includes('Cloudflare')) {
      console.log('   Waiting for Turnstile challenge...');
      await page.waitForFunction(() => !(globalThis as any).document.title.includes('moment'), { timeout: 30000 });
      await page.waitForTimeout(2000);
    }

    // Step 2: Fill login form. Tock's stable data-testid hooks are used instead of
    // CSS/name selectors because the class names are hashed and change between builds.
    console.log('   Filling login form...');
    const emailInput = page.locator('[data-testid="email-input"]');
    const passwordInput = page.locator('[data-testid="password-input"]');

    // Gate on the email field being visible — its appearance is our signal that
    // Turnstile is fully cleared and the real login SPA has rendered.
    await emailInput.waitFor({ state: 'visible', timeout: 15000 });
    await emailInput.fill(email);
    // Small human-like pauses between fills; instantaneous multi-field entry is a
    // bot tell and can also outrun the form's own React state updates.
    await page.waitForTimeout(300);
    await passwordInput.fill(password);
    await page.waitForTimeout(300);

    // Step 3: Click login button
    console.log('   Clicking login...');
    const loginBtn = page.locator('[data-testid="signin"]');
    await loginBtn.click();

    // Step 4: Success is defined purely by navigation — Tock redirects off /login on
    // a valid sign-in. Waiting for the URL to leave /login is more robust than looking
    // for a success element, since the post-login destination varies.
    console.log('   Waiting for login to complete...');
    try {
      await page.waitForURL(url => !url.toString().includes('/login'), { timeout: 15000 });
    } catch {
      // Timing out means we're still stuck on /login — i.e. login did NOT succeed.
      // Scrape any inline error banner to distinguish bad credentials from a
      // Turnstile block, but fall back to a generic message when none is found.
      const errorText = await page.evaluate(() => {
        const err = (globalThis as any).document.querySelector('[class*="error"], [class*="Error"], [role="alert"]');
        return err ? err.textContent?.trim() : null;
      });
      const msg = errorText || 'Login failed — wrong email/password or Turnstile blocked';
      console.error(`   ${msg}`);
      return { success: false, error: msg };
    }
    // Let the post-login page settle so any deferred/httpOnly session cookies
    // (set during the redirect handshake) are written before we read them.
    await page.waitForTimeout(2000);

    const finalUrl = page.url();
    console.log(`   Landed on: ${finalUrl}`);

    // Step 5: Extract all cookies. Keep only Tock-domain cookies (drop Cloudflare/
    // third-party ones) and reshape Playwright's Cookie into our TockCookie contract.
    // Note: Playwright uses expires === -1 (or 0) to mean a session cookie with no
    // expiry, so normalize any non-positive value to undefined.
    const browserCookies = await context.cookies();
    const tockCookies: TockCookie[] = browserCookies
      .filter(c => c.domain.includes('exploretock.com') || c.domain.includes('tock'))
      .map(c => ({
        name: c.name,
        value: c.value,
        domain: c.domain,
        path: c.path,
        httpOnly: c.httpOnly,
        secure: c.secure,
        sameSite: c.sameSite as 'Strict' | 'Lax' | 'None',
        expires: c.expires > 0 ? c.expires : undefined,
      }));

    console.log(`   Extracted ${tockCookies.length} cookies (${browserCookies.length} total)`);

    // Step 6: Store cookies
    updateCookies(tockCookies);
    console.log(`✅ Login successful! ${tockCookies.length} cookies saved.`);

    return { success: true, cookieCount: tockCookies.length };

  } catch (err) {
    // Any thrown failure (nav timeout, selector not found, launch error) is funneled
    // into the same { success:false, error } shape so callers never have to try/catch.
    const error = err instanceof Error ? err.message : String(err);
    console.error('❌ Login failed:', error);
    return { success: false, error };
  } finally {
    // Always tear down the browser, even on early returns/throws, so headless
    // Chromium processes don't leak and exhaust the container's memory.
    if (browser) await browser.close();
  }
}
