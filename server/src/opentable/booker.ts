// server/src/opentable/booker.ts
import { chromium, Browser, BrowserContext, Page } from 'playwright';
import { BookingRequest, BookingResult, STEALTH_ARGS, randomDelay } from '../booker';
import { injectCookies } from '../cookies';
import { buildOpenTableSearchUrl } from './url';
import { parseSlots, pickBestSlot } from './availability';
import { OT_SELECTORS } from './selectors';

async function readSlots(page: Page): Promise<{ testid: string; text: string }[]> {
  return page.$$eval(OT_SELECTORS.profile.timeSlot, (els) =>
    els.map((el) => ({
      testid: el.getAttribute('data-testid') || '',
      text: (el.querySelector('[role="button"]')?.textContent || el.textContent || '').trim(),
    }))
  );
}

export async function runOpenTableBookingWithContext(
  context: BrowserContext, req: BookingRequest, signal?: AbortSignal
): Promise<BookingResult> {
  const screenshots: string[] = [];
  try {
    const page = await context.newPage();
    await page.addInitScript(() => {
      Object.defineProperty((globalThis as any).navigator, 'webdriver', { get: () => false });
    });

    const url = buildOpenTableSearchUrl(req.restaurant, req.dates[0], req.time, req.partySize);
    console.log(`📍 [OT] Navigating: ${url}`);
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(randomDelay(800, 1500));
    if (signal?.aborted) return { success: false, error: 'Aborted', screenshots };

    // Guard: OpenTable "Access Denied" means we have no valid session cookies.
    if ((await page.title()).includes('Access Denied')) {
      return { success: false, error: 'OpenTable Access Denied — push a fresh OpenTable session (cookies missing/expired).', screenshots };
    }

    // Wait for slots to render.
    try {
      await page.waitForSelector(OT_SELECTORS.profile.timeSlot, { timeout: 15000 });
    } catch {
      return { success: false, error: 'No time slots rendered (sold out, wrong date, or selector drift).', screenshots };
    }

    const slots = parseSlots(await readSlots(page));
    const best = pickBestSlot(slots, req.time);
    if (!best) return { success: false, error: `No slots on ${req.dates[0]}. Seen: ${slots.map(s => s.time12).join(', ') || 'none'}`, screenshots };

    console.log(`🎯 [OT] Clicking slot ${best.time12} (${best.testid})`);
    await page.locator(`[data-testid="${best.testid}"] [role="button"], [data-testid="${best.testid}"]`).first().click();
    await page.waitForTimeout(randomDelay(1500, 3000));
    if (signal?.aborted) return { success: false, bookedDate: req.dates[0], bookedTime: best.time12, error: 'Aborted after slot click', screenshots };

    if (req.autoPurchase === false) {
      return { success: true, bookedDate: req.dates[0], bookedTime: best.time12, screenshots };
    }

    // Checkout completion is Task 10; until then, report held-only (fail-closed: no purchase).
    const { handleOpenTableCheckout } = await import('./checkout');
    const done = await handleOpenTableCheckout(page, req, screenshots);
    return done.success
      ? { success: true, bookedDate: req.dates[0], bookedTime: best.time12, screenshots }
      : { success: false, bookedDate: req.dates[0], bookedTime: best.time12, error: done.error, screenshots };
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : String(err), screenshots };
  }
}

export async function runOpenTableBooking(req: BookingRequest): Promise<BookingResult> {
  let browser: Browser | null = null;
  try {
    browser = await chromium.launch({ headless: true, channel: 'chromium', args: STEALTH_ARGS });
    const context = await browser.newContext({
      viewport: { width: 1440, height: 900 },
      userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
      locale: 'en-US', timezoneId: 'America/Los_Angeles',
    });
    const n = await injectCookies(context, 'opentable');
    if (n === 0) return { success: false, error: 'No OpenTable cookies configured. Push a session first.' };
    return await runOpenTableBookingWithContext(context, req);
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : String(err) };
  } finally {
    if (browser) await browser.close();
  }
}
