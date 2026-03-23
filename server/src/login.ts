import { chromium } from 'playwright';
import { updateCookies, TockCookie } from './cookies';

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
      headless: false, // Headed mode needed to pass Turnstile
      args: STEALTH_ARGS,
    });

    const context = await browser.newContext({
      viewport: { width: 1440, height: 900 },
      userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    });

    const page = await context.newPage();
    await page.addInitScript(() => {
      Object.defineProperty((globalThis as any).navigator, 'webdriver', { get: () => false });
    });

    // Step 1: Navigate to login page (go via homepage to warm up Turnstile)
    console.log('   Navigating to login page...');
    await page.goto('https://www.exploretock.com/login', { waitUntil: 'domcontentloaded', timeout: 30000 });

    // Wait for Turnstile challenge to resolve
    await page.waitForTimeout(5000);

    // If we got redirected to Turnstile challenge page, wait longer
    const title = await page.title();
    if (title.includes('moment') || title.includes('Cloudflare')) {
      console.log('   Waiting for Turnstile challenge...');
      await page.waitForFunction(() => !(globalThis as any).document.title.includes('moment'), { timeout: 30000 });
      await page.waitForTimeout(2000);
    }

    // Step 2: Fill login form
    console.log('   Filling login form...');
    const emailInput = page.locator('[data-testid="email-input"]');
    const passwordInput = page.locator('[data-testid="password-input"]');

    await emailInput.waitFor({ state: 'visible', timeout: 15000 });
    await emailInput.fill(email);
    await page.waitForTimeout(300);
    await passwordInput.fill(password);
    await page.waitForTimeout(300);

    // Step 3: Click login button
    console.log('   Clicking login...');
    const loginBtn = page.locator('[data-testid="signin"]');
    await loginBtn.click();

    // Step 4: Wait for navigation (successful login redirects away from /login)
    console.log('   Waiting for login to complete...');
    try {
      await page.waitForURL(url => !url.toString().includes('/login'), { timeout: 15000 });
    } catch {
      // Check if there's an error message on the page
      const errorText = await page.evaluate(() => {
        const err = (globalThis as any).document.querySelector('[class*="error"], [class*="Error"], [role="alert"]');
        return err ? err.textContent?.trim() : null;
      });
      const msg = errorText || 'Login failed — wrong email/password or Turnstile blocked';
      console.error(`   ${msg}`);
      return { success: false, error: msg };
    }
    await page.waitForTimeout(2000);

    const finalUrl = page.url();
    console.log(`   Landed on: ${finalUrl}`);

    // Step 5: Extract all cookies
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
    const error = err instanceof Error ? err.message : String(err);
    console.error('❌ Login failed:', error);
    return { success: false, error };
  } finally {
    if (browser) await browser.close();
  }
}
