/**
 * booker.ts — single-shot Tock booking + the shared Stripe/checkout purchase flow.
 *
 * Responsibility: given a {@link BookingRequest} (restaurant slug, candidate dates,
 * party size, time), drive one Playwright page from the search calendar through slot
 * selection and, if enabled, all the way through Tock's checkout to a completed purchase.
 *
 * Role in the system: this is the "single-shot" booker used directly by {@link runBooking}
 * and by the higher-frequency engines that reuse a warm browser context — the sniper
 * (sniper.ts) and blitz mode (blitz.ts) both call {@link runBookingWithContext} /
 * {@link handlePurchaseFlow} rather than re-implementing checkout. The checkout stage is
 * the shared, fail-closed critical path: it fills payment (saved-card CVC-only or a full
 * new-card Stripe form via stripe.ts), then enforces a grand-total price cap before it
 * will ever click "Purchase".
 *
 * Key exports:
 *  - {@link BookingRequest} / {@link BookingResult} — the input/output contract.
 *  - {@link runBooking} — launch a browser, inject cookies, book, close (self-contained).
 *  - {@link runBookingWithContext} — book on a caller-supplied warm context (+ AbortSignal).
 *  - {@link handlePurchaseFlow} — the checkout state-machine (add-ons → confirm → purchase).
 *  - {@link parseAmountDueCents} — pure, unit-tested parser for the price-cap guard.
 *  - {@link STEALTH_ARGS}, {@link randomDelay}, {@link to12Hour} — shared launch/timing/format helpers.
 */
import { chromium, Browser, Page, BrowserContext, Frame } from 'playwright';
import { injectCookies } from './cookies';
import { fillStripePayment, fillStripeBilling, PaymentDetails, getPayment } from './stripe';

/**
 * Find the (cross-origin) frame that hosts a CVC/CVV input for saved-card checkout.
 *
 * In saved-card mode Tock only asks for the security code, but that field can live in
 * either a Stripe iframe (name="cvc") or a Braintree hosted-field iframe (name="cvv"),
 * so we probe every frame for any of the known selectors rather than assume one vendor.
 * Returns the first matching frame, or null (caller then falls back to a same-page input).
 * Per-frame errors are swallowed: cross-origin frames can throw on access and must not
 * abort the scan.
 */
async function findCvcFrame(page: Page): Promise<Frame | null> {
  for (const frame of page.frames()) {
    try {
      const count = await frame.locator('input[name="cvv"], input[name="cvc"], input[placeholder="CVC"], input[autocomplete="cc-csc"]').count();
      if (count > 0) return frame;
    } catch { /* skip */ }
  }
  return null;
}

/**
 * A single booking attempt's inputs.
 * `dates` is a priority-ordered candidate list — the booker tries them in order and takes
 * the first one that actually has availability, so callers pass fallbacks, not just one date.
 * `autoPurchase` defaults to ON at the call sites (only `=== false` skips checkout);
 * `dryRun` walks the whole flow and captures screenshots but never clicks Purchase.
 */
export interface BookingRequest {
  restaurant: string;
  dates: string[];     // YYYY-MM-DD in priority order
  partySize: number;
  time: string;        // HH:MM 24-hour
  autoPurchase?: boolean;
  dryRun?: boolean;
}

/**
 * Outcome of a booking attempt. `bookedDate`/`bookedTime` may be set even when
 * `success` is false — a slot was grabbed but the later purchase stage failed — so
 * callers can distinguish "nothing booked" from "held but not paid".
 * `screenshots` are base64 PNGs, populated on the dry-run path (and on failures for triage).
 */
export interface BookingResult {
  success: boolean;
  bookedDate?: string;
  bookedTime?: string;
  error?: string;
  screenshots?: string[]; // base64 screenshots if dryRun
}

/**
 * Chromium launch flags shared by every browser we start.
 * `--disable-blink-features=AutomationControlled` is the anti-detection flag — it stops
 * Chrome from advertising itself as automated (paired with the `navigator.webdriver`
 * override in {@link runBookingWithContext}). The `--no-sandbox` / `--disable-setuid-sandbox`
 * / `--disable-dev-shm-usage` trio is required to run headless Chromium in the Railway
 * container (no user namespaces, tiny /dev/shm).
 */
export const STEALTH_ARGS = [
  '--disable-blink-features=AutomationControlled',
  '--no-sandbox',
  '--disable-setuid-sandbox',
  '--disable-dev-shm-usage',
];

/** Random human-ish pause (ms) inserted between actions to look less scripted to Tock. */
export function randomDelay(min = 200, max = 500): number {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

/** Convert 24-hour time to 12-hour display (e.g., "17:00" → "5:00 PM") */
export function to12Hour(time24: string): string {
  const [h, m] = time24.split(':').map(Number);
  const period = h >= 12 ? 'PM' : 'AM';
  const hour12 = h === 0 ? 12 : h > 12 ? h - 12 : h;
  return `${hour12}:${m.toString().padStart(2, '0')} ${period}`;
}

/**
 * Run a booking using an already-created browser context.
 * Accepts an optional AbortSignal for cancellation (used by blitz mode).
 */
export async function runBookingWithContext(
  context: BrowserContext,
  req: BookingRequest,
  signal?: AbortSignal
): Promise<BookingResult> {
  const screenshots: string[] = [];

  try {
    const page = await context.newPage();

    // Remove webdriver flag to avoid bot detection
    await page.addInitScript(() => {
      Object.defineProperty((globalThis as any).navigator, 'webdriver', { get: () => false });
    });

    // Navigate to search page with primary date
    const searchUrl = `https://www.exploretock.com/${req.restaurant}/search?date=${req.dates[0]}&size=${req.partySize}&time=${encodeURIComponent(req.time)}`;
    console.log(`📍 Navigating to: ${searchUrl}`);
    await page.goto(searchUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(randomDelay(500, 1000));

    if (signal?.aborted) return { success: false, error: 'Aborted', screenshots };

    if (req.dryRun) screenshots.push(await takeScreenshot(page));

    // Wait for calendar to load
    console.log('📅 Waiting for calendar...');
    try {
      await page.waitForSelector('.ConsumerCalendar', { state: 'visible', timeout: 15000 });
    } catch {
      return { success: false, error: 'Calendar did not load. Check cookies / restaurant slug.', screenshots };
    }

    if (signal?.aborted) return { success: false, error: 'Aborted', screenshots };

    // Read available dates from calendar
    const availableDates = await page.$$eval(
      '.ConsumerCalendar-day.is-available.is-in-month:not(.is-disabled):not(.is-sold)',
      els => els.map(el => el.getAttribute('aria-label')).filter(Boolean) as string[]
    );
    console.log(`📅 Available dates: ${availableDates.join(', ')}`);

    // Filter requested dates to only available ones
    const datesToTry = req.dates.filter(d => availableDates.includes(d));
    if (datesToTry.length === 0) {
      return { success: false, error: `No requested dates available. Available: ${availableDates.join(', ')}`, screenshots };
    }
    console.log(`🎯 Will try: ${datesToTry.join(', ')}`);

    // Try each date until we find availability at the preferred time
    let bookedDate: string | undefined;
    let bookedTime: string | undefined;

    for (const date of datesToTry) {
      if (signal?.aborted) return { success: false, error: 'Aborted', screenshots };

      console.log(`\n🔍 Trying date: ${date}`);

      // Click the date in the calendar
      const dateButton = page.locator(`.ConsumerCalendar-day.is-in-month.is-available[aria-label="${date}"]:not([disabled])`).first();
      await dateButton.scrollIntoViewIfNeeded();
      await dateButton.click();
      await page.waitForTimeout(randomDelay(300, 600));

      // Wait for time slots / book buttons to appear
      try {
        await page.waitForSelector('[data-testid="booking-card-button"]', { timeout: 10000 });
      } catch {
        console.log(`   No time slots for ${date}`);
        continue;
      }

      // Find the book button matching preferred time
      const preferredTime12 = to12Hour(req.time);
      const bookButtons = await page.$$('[data-testid="booking-card-button"]');
      let matchedButton = null;
      let matchedTimeText = '';

      for (const button of bookButtons) {
        // The book button itself has no time label — the "5:00 PM" text lives on an
        // ancestor card. Walk up to 6 parents looking for the first h:mm AM/PM string;
        // 6 is empirically enough to escape the button's inner wrappers without
        // bleeding into a sibling slot's time.
        const timeText = await button.evaluate((el: any) => {
          let node = el;
          for (let i = 0; i < 6; i++) {
            node = node?.parentElement || null;
            if (!node) break;
            const text = node.textContent || '';
            const match = text.match(/(\d{1,2}):(\d{2})\s*(AM|PM)/i);
            if (match) return match[0];
          }
          return '';
        });

        if (!timeText) continue;

        if (timeText.toLowerCase() === preferredTime12.toLowerCase()) {
          matchedButton = button;
          matchedTimeText = timeText;
          break;
        }

        // Fallback: if no slot matches the requested time exactly, keep the FIRST slot
        // we saw (earliest offered, not nearest-by-clock) so the date isn't abandoned
        // over a few minutes' difference. An exact match above wins and breaks the loop.
        if (!matchedButton) {
          matchedButton = button;
          matchedTimeText = timeText;
        }
      }

      if (matchedButton) {
        console.log(`   ✅ Booking: ${date} at ${matchedTimeText}`);
        await matchedButton.scrollIntoViewIfNeeded();
        await matchedButton.click();
        bookedDate = date;
        bookedTime = matchedTimeText;
        break;
      }
    }

    if (!bookedDate) {
      return { success: false, error: 'No available time slots found on any date', screenshots };
    }

    if (signal?.aborted) return { success: false, error: 'Aborted', screenshots };

    if (req.dryRun) screenshots.push(await takeScreenshot(page));

    // Handle post-booking flow (add-ons → purchase)
    if (req.autoPurchase !== false) {
      const purchaseResult = await handlePurchaseFlow(page, req.dryRun ?? false, screenshots);
      if (!purchaseResult) {
        return { success: false, bookedDate, bookedTime, error: 'Purchase flow failed', screenshots };
      }
    }

    console.log(`\n🎉 Booking complete: ${bookedDate} at ${bookedTime}`);
    return { success: true, bookedDate, bookedTime, screenshots };

  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    console.error('❌ Booking error:', error);
    return { success: false, error, screenshots };
  }
}

/** Convenience wrapper: launches a browser, runs the booking, and closes the browser. */
export async function runBooking(req: BookingRequest): Promise<BookingResult> {
  let browser: Browser | null = null;

  try {
    console.log(`\n🚀 Starting booking: ${req.restaurant}`);
    console.log(`   Dates: ${req.dates.join(', ')}`);
    console.log(`   Party: ${req.partySize}, Time: ${req.time}`);
    console.log(`   Auto-purchase: ${req.autoPurchase ?? false}, Dry run: ${req.dryRun ?? false}`);

    browser = await chromium.launch({ headless: true, channel: 'chromium', args: STEALTH_ARGS });
    const context = await browser.newContext({
      viewport: { width: 1440, height: 900 },
      userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    });

    const cookieCount = await injectCookies(context);
    console.log(`🍪 Injected ${cookieCount} cookies`);
    if (cookieCount === 0) {
      return { success: false, error: 'No Tock cookies configured. Set TOCK_COOKIES env var.' };
    }

    return await runBookingWithContext(context, req);
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    console.error('❌ Booking error:', error);
    return { success: false, error };
  } finally {
    if (browser) await browser.close();
  }
}

/** Parse the grand-total "Amount due $X" out of confirm-page text → cents.
 *  - Requires a literal `$` directly after "Amount due" (allowing whitespace/colon), so a
 *    "per person" line ("Amount due per person $125") does NOT match here and non-currency
 *    text ("Amount due 50% deposit") can never false-match a bogus low number.
 *  - Returns the LARGEST matching amount (the grand total is the biggest "Amount due $…").
 *  - null when no dollar total is present — the caller treats null as fail-closed (abort). */
export function parseAmountDueCents(text: string): number | null {
  const matches = [...String(text).matchAll(/amount due\s*:?\s*\$\s*([\d,]+(?:\.\d{2})?)/gi)];
  if (!matches.length) return null;
  const cents = matches.map(m => Math.round(parseFloat(m[1].replace(/,/g, '')) * 100));
  return Math.max(...cents);
}

/** Read the grand-total "Amount due" on the confirm page, in cents; null if unreadable. */
async function readAmountDueCents(page: Page): Promise<number | null> {
  try {
    const txt: string = await page.evaluate(() => (globalThis as any).document?.body?.innerText || '');
    return parseAmountDueCents(txt);
  } catch (err) {
    console.error('❌ readAmountDueCents failed:', err instanceof Error ? err.message : String(err));
    return null;
  }
}

/**
 * Drive Tock's post-slot checkout as a polling state-machine until the purchase page
 * appears, then hand off to {@link handlePurchaseConfirmation}.
 *
 * Tock inserts a variable number of interstitials after a slot is grabbed (add-ons /
 * supplement pages, a "View Order" modal) with no fixed order or count, so instead of a
 * linear script we loop for up to `maxWait` (30s), detecting whichever page is currently
 * showing by its testid and advancing it, until either the purchase button shows up or we
 * time out.
 *
 * Failure contract: a timeout, or a *reasoned* abort inside confirmation (price cap hit,
 * amount-due unreadable), THROWS with a short summary of the accumulated `problems`.
 * That matters because callers (sniper/scheduler) catch and persist the thrown message
 * into booking history, so an operator can diagnose a failed checkout from the dashboard
 * within the ~10-min hold window — not only from ephemeral Railway stdout.
 *
 * @param maxPriceCents optional grand-total cap in cents; forwarded to the fail-closed guard.
 * @returns true if the purchase completed (or dry-run reached the button); throws on
 *          timeout/abort rather than returning false when there's a diagnosable reason.
 */
export async function handlePurchaseFlow(page: Page, dryRun: boolean, screenshots: string[], maxPriceCents?: number): Promise<boolean> {
  console.log('🛒 Starting purchase flow...');
  await page.waitForTimeout(1000);

  const maxWait = 30000;
  const start = Date.now();
  // Obstacles hit along the way. Surfaced by THROWING at timeout/abort — every caller
  // catches and persists the message, so a purchase-stage failure is diagnosable from
  // history within the ~10-min hold window, not just from Railway stdout.
  const problems: string[] = [];
  const note = (m: string) => { problems.push(m); console.log(`   ⚠️ ${m}`); };

  while (Date.now() - start < maxWait) {
    // Check for add-ons page. A DISABLED confirm (seen live on Lazy Bear 2026-07-02)
    // must not block the loop on a 30s click wait — keep cycling so the purchase page
    // can still be caught if it appears another way, or the loop times out cleanly.
    const addOnsBtn = await page.$('[data-testid="supplement-group-confirm-button"]');
    if (addOnsBtn) {
      if (await addOnsBtn.isEnabled().catch(() => false)) {
        console.log('📦 Skipping add-ons...');
        await addOnsBtn.click({ timeout: 5000 }).catch(err => note(`add-ons confirm click failed: ${err instanceof Error ? err.message : err}`));
        await page.waitForTimeout(1500);
      } else {
        if (!problems.includes('add-ons confirm present but disabled')) note('add-ons confirm present but disabled');
        await page.waitForTimeout(500);
      }
      continue;
    }

    // Check for alternate add-ons (View Order)
    const viewOrderBtn = await page.$('[data-testid="supplement-page-view-order"]');
    if (viewOrderBtn) {
      console.log('📦 Clicking View Order...');
      await viewOrderBtn.click({ timeout: 5000 }).catch(err => note(`view-order click failed: ${err instanceof Error ? err.message : err}`));
      await page.waitForTimeout(500);
      const modalBtn = await page.$('.MuiDialogActions-root button');
      if (modalBtn) await modalBtn.click({ timeout: 5000 }).catch(err => note(`view-order modal click failed: ${err instanceof Error ? err.message : err}`));
      await page.waitForTimeout(1500);
      continue;
    }

    // Check for purchase confirmation page
    const purchaseBtn = await page.$('[data-testid="purchase-button"]');
    if (purchaseBtn) {
      console.log('💳 Purchase confirmation page detected');
      const ok = await handlePurchaseConfirmation(page, dryRun, screenshots, maxPriceCents, problems);
      // A reasoned abort (price cap, unreadable amount) must reach history, not just stdout.
      if (!ok && problems.length) throw new Error(`checkout aborted — ${[...new Set(problems)].slice(-3).join('; ')}`);
      return ok;
    }

    await page.waitForTimeout(300);
  }

  const detail = problems.length ? ` — obstacles: ${[...new Set(problems)].slice(-3).join('; ')}` : '';
  console.log(`⏱️ Timeout waiting for purchase page${detail}`);
  throw new Error(`Timeout waiting for purchase page${detail}`);
}

/**
 * Fill and finalize Tock's purchase-confirmation page.
 *
 * Ordered steps: (1) force "No gratuity" if a gratuity picker is present; (2) tick the
 * marketing/consent checkboxes Tock requires to enable the button; (3) fill payment —
 * auto-detecting saved-card mode (CVC-only, in a Stripe *or* Braintree iframe, or a plain
 * page input) vs. new-card mode (full Stripe Payment + Address elements via stripe.ts);
 * (4) enforce the price cap; (5) click Purchase (unless dry-run).
 *
 * Saved-card detection is deliberately belt-and-suspenders: it checks for the known
 * testids AND for the on-page copy ("Select credit card" / "confirm your credit card
 * security code"), because Tock has shipped the saved-card UI without a stable testid.
 *
 * Price cap is the authoritative, fail-closed overspend guard: when `maxPriceCents` is
 * set we read the real grand-total "Amount due" and abort if it exceeds the cap OR if the
 * total can't be read at all (never buy blind). Aborts push a reason into `problems` so
 * {@link handlePurchaseFlow} can throw it into history.
 *
 * @returns true on a completed purchase (or a dry-run that reached the button); false on
 *          an abort (missing/failed payment, cap exceeded, unreadable total). Note: in
 *          dry-run with no payment configured it returns `dryRun` (true) — a dry run is
 *          allowed to "pass" without card details since it never actually charges.
 */
async function handlePurchaseConfirmation(page: Page, dryRun: boolean, screenshots: string[], maxPriceCents?: number, problems?: string[]): Promise<boolean> {
  // Gratuity — select "No gratuity" if present
  const gratuityBtn = await page.$('[data-testid="gratuity-button-zero"]');
  if (gratuityBtn) {
    const pressed = await gratuityBtn.getAttribute('aria-pressed');
    if (pressed !== 'true') {
      console.log('💰 Selecting no gratuity');
      await gratuityBtn.click();
      await page.waitForTimeout(200);
    }
  }

  // Check consent checkboxes
  for (const testId of ['checkout-consents-to-text', 'checkout-opt-in-email']) {
    const checkbox = await page.$(`[data-testid="${testId}"]`);
    if (checkbox) {
      const checked = await checkbox.isChecked().catch(() => false);
      if (!checked) {
        console.log(`☑️ Checking ${testId}`);
        await checkbox.click();
        await page.waitForTimeout(200);
      }
    }
  }

  // Wait for payment section to load
  await page.waitForTimeout(3000);

  // Detect payment mode: saved card (CVC-only) vs new card (full Stripe form)
  const savedCardDropdown = await page.$('[data-testid="saved-card-select"]');
  const cvcOnlyField = await page.$('[data-testid="cvc-input-field"], #braintree-hosted-field-cvv');
  const hasSavedCard = !!(savedCardDropdown || cvcOnlyField);

  // Also check for "Select credit card" text which indicates saved card mode
  const pageText = await page.evaluate(() => (globalThis as any).document.body?.innerText?.slice(0, 3000) || '');
  const hasSavedCardText = pageText.includes('Select credit card') || pageText.includes('confirm your credit card security code');

  const payment = getPayment();

  if (hasSavedCard || hasSavedCardText) {
    // Saved card mode — just need to fill CVC
    console.log('💳 Saved card detected — filling CVC only');

    if (!payment?.cvc) {
      console.log('⚠️ No CVC configured');
      screenshots.push(await takeScreenshot(page));
      return dryRun;
    }

    try {
      // Try to find CVC field — could be a Braintree iframe or a regular Stripe iframe
      const cvcFrame = await findCvcFrame(page);
      if (cvcFrame) {
        const cvcInput = cvcFrame.locator('input[name="cvv"], input[name="cvc"], input[placeholder="CVC"], input[autocomplete="cc-csc"]').first();
        await cvcInput.click();
        await page.waitForTimeout(200);
        await cvcInput.fill(payment.cvc);
        console.log('✅ CVC filled');
      } else {
        // CVC might be a regular input on the page (not in an iframe)
        const cvcInput = page.locator('[data-testid="cvc-input-field"] input, input[placeholder="CVC"]').first();
        await cvcInput.click();
        await page.waitForTimeout(200);
        await cvcInput.fill(payment.cvc);
        console.log('✅ CVC filled (page input)');
      }
    } catch (err) {
      console.error('❌ CVC fill error:', err);
      screenshots.push(await takeScreenshot(page));
      return false;
    }
  } else {
    // New card mode — fill all Stripe fields
    console.log('💳 New card form detected — filling all fields');

    if (!payment) {
      console.log('⚠️ No payment details configured (set via UI or CARD_NUMBER env var)');
      screenshots.push(await takeScreenshot(page));
      return dryRun;
    }

    try {
      await fillStripePayment(page, payment);
      await page.waitForTimeout(500);
      await fillStripeBilling(page, payment);
      await page.waitForTimeout(500);
    } catch (err) {
      console.error('❌ Stripe fill error:', err);
      screenshots.push(await takeScreenshot(page));
      return false;
    }
  }

  // Price cap (TOTAL amount due, the authoritative overspend guard): never purchase (or
  // "succeed" a dry run) if the actual grand-total amount due exceeds the cap. If a cap is
  // set but the amount can't be read, abort to be safe — don't buy blind.
  if (maxPriceCents != null) {
    const dueCents = await readAmountDueCents(page);
    if (dueCents == null) {
      console.log('🛑 Price cap set but could not read amount due — aborting (no blind purchase)');
      problems?.push('price cap set but "Amount due $" not readable on confirm page — aborted, no blind purchase');
      screenshots.push(await takeScreenshot(page));
      return false;
    }
    if (dueCents > maxPriceCents) {
      console.log(`🛑 Amount due $${(dueCents / 100).toFixed(2)} exceeds cap $${(maxPriceCents / 100).toFixed(2)} — aborting purchase`);
      problems?.push(`amount due $${(dueCents / 100).toFixed(2)} exceeds cap $${(maxPriceCents / 100).toFixed(2)} — aborted`);
      screenshots.push(await takeScreenshot(page));
      return false;
    }
    console.log(`💵 Amount due $${(dueCents / 100).toFixed(2)} is within cap $${(maxPriceCents / 100).toFixed(2)}`);
  }

  if (dryRun) {
    console.log('🏁 Dry run — skipping purchase button click');
    screenshots.push(await takeScreenshot(page));
    return true;
  }

  // Click purchase button
  const purchaseBtn = page.locator('[data-testid="purchase-button"]');
  console.log('🛒 Clicking purchase button...');
  await purchaseBtn.click();
  console.log('✅ Purchase button clicked');

  // Wait for confirmation/redirect
  await page.waitForTimeout(5000);
  screenshots.push(await takeScreenshot(page));

  return true;
}

/** Capture the current viewport (not full page) as a base64 PNG for the dry-run /
 *  failure screenshot trail returned in {@link BookingResult.screenshots}. */
async function takeScreenshot(page: Page): Promise<string> {
  const buffer = await page.screenshot({ fullPage: false });
  return buffer.toString('base64');
}
