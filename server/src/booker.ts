import { chromium, Browser, Page, BrowserContext } from 'playwright';
import { injectCookies } from './cookies';
import { fillStripePayment, fillStripeBilling, PaymentDetails, getPayment } from './stripe';

export interface BookingRequest {
  restaurant: string;
  dates: string[];     // YYYY-MM-DD in priority order
  partySize: number;
  time: string;        // HH:MM 24-hour
  autoPurchase?: boolean;
  dryRun?: boolean;
}

export interface BookingResult {
  success: boolean;
  bookedDate?: string;
  bookedTime?: string;
  error?: string;
  screenshots?: string[]; // base64 screenshots if dryRun
}

const STEALTH_ARGS = [
  '--disable-blink-features=AutomationControlled',
  '--no-sandbox',
  '--disable-setuid-sandbox',
  '--disable-dev-shm-usage',
];

function randomDelay(min = 200, max = 500): number {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

/** Convert 24-hour time to 12-hour display (e.g., "17:00" → "5:00 PM") */
function to12Hour(time24: string): string {
  const [h, m] = time24.split(':').map(Number);
  const period = h >= 12 ? 'PM' : 'AM';
  const hour12 = h === 0 ? 12 : h > 12 ? h - 12 : h;
  return `${hour12}:${m.toString().padStart(2, '0')} ${period}`;
}

export async function runBooking(req: BookingRequest): Promise<BookingResult> {
  const screenshots: string[] = [];
  let browser: Browser | null = null;

  try {
    console.log(`\n🚀 Starting booking: ${req.restaurant}`);
    console.log(`   Dates: ${req.dates.join(', ')}`);
    console.log(`   Party: ${req.partySize}, Time: ${req.time}`);
    console.log(`   Auto-purchase: ${req.autoPurchase ?? false}, Dry run: ${req.dryRun ?? false}`);

    // Launch browser
    browser = await chromium.launch({
      headless: true,
      args: STEALTH_ARGS,
    });

    const context = await browser.newContext({
      viewport: { width: 1440, height: 900 },
      userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    });

    // Inject authenticated cookies
    const cookieCount = await injectCookies(context);
    console.log(`🍪 Injected ${cookieCount} cookies`);
    if (cookieCount === 0) {
      return { success: false, error: 'No Tock cookies configured. Set TOCK_COOKIES env var.' };
    }

    const page = await context.newPage();

    // Navigate to search page with primary date
    const searchUrl = `https://www.exploretock.com/${req.restaurant}/search?date=${req.dates[0]}&size=${req.partySize}&time=${encodeURIComponent(req.time)}`;
    console.log(`📍 Navigating to: ${searchUrl}`);
    await page.goto(searchUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(randomDelay(500, 1000));

    if (req.dryRun) screenshots.push(await takeScreenshot(page));

    // Wait for calendar to load
    console.log('📅 Waiting for calendar...');
    try {
      await page.waitForSelector('.ConsumerCalendar', { state: 'visible', timeout: 15000 });
    } catch {
      return { success: false, error: 'Calendar did not load. Check cookies / restaurant slug.', screenshots };
    }

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
        // Walk up the DOM to find the time text
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

        // Track closest match as fallback
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
  } finally {
    if (browser) await browser.close();
  }
}

async function handlePurchaseFlow(page: Page, dryRun: boolean, screenshots: string[]): Promise<boolean> {
  console.log('🛒 Starting purchase flow...');
  await page.waitForTimeout(1000);

  const maxWait = 30000;
  const start = Date.now();

  while (Date.now() - start < maxWait) {
    // Check for add-ons page
    const addOnsBtn = await page.$('[data-testid="supplement-group-confirm-button"]');
    if (addOnsBtn) {
      console.log('📦 Skipping add-ons...');
      await addOnsBtn.click();
      await page.waitForTimeout(1500);
      continue;
    }

    // Check for alternate add-ons (View Order)
    const viewOrderBtn = await page.$('[data-testid="supplement-page-view-order"]');
    if (viewOrderBtn) {
      console.log('📦 Clicking View Order...');
      await viewOrderBtn.click();
      await page.waitForTimeout(500);
      const modalBtn = await page.$('.MuiDialogActions-root button');
      if (modalBtn) await modalBtn.click();
      await page.waitForTimeout(1500);
      continue;
    }

    // Check for purchase confirmation page
    const purchaseBtn = await page.$('[data-testid="purchase-button"]');
    if (purchaseBtn) {
      console.log('💳 Purchase confirmation page detected');
      return await handlePurchaseConfirmation(page, dryRun, screenshots);
    }

    await page.waitForTimeout(300);
  }

  console.log('⏱️ Timeout waiting for purchase page');
  return false;
}

async function handlePurchaseConfirmation(page: Page, dryRun: boolean, screenshots: string[]): Promise<boolean> {
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

  // Fill payment details
  const payment = getPayment();
  if (!payment) {
    console.log('⚠️ No payment details configured (set via UI or CARD_NUMBER env var)');
    if (dryRun) screenshots.push(await takeScreenshot(page));
    return dryRun; // dryRun succeeds without payment
  }

  try {
    await fillStripePayment(page, payment);
    await page.waitForTimeout(500);
    await fillStripeBilling(page, payment);
    await page.waitForTimeout(500);
  } catch (err) {
    console.error('❌ Stripe fill error:', err);
    if (dryRun) screenshots.push(await takeScreenshot(page));
    return false;
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

async function takeScreenshot(page: Page): Promise<string> {
  const buffer = await page.screenshot({ fullPage: false });
  return buffer.toString('base64');
}
