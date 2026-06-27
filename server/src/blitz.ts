import { chromium, Browser, Page } from 'playwright';
import { BookingRequest, BookingResult, STEALTH_ARGS, randomDelay, to12Hour, handlePurchaseFlow } from './booker';
import { injectCookies } from './cookies';

export interface BlitzConfig {
  attempts: number;    // 1-5
  staggerMs: number;   // ms between each attempt, e.g. 1000
}

/** Outcome of a single blitz attempt — captured for post-run visibility. */
export interface AttemptOutcome {
  attempt: number;           // 1-indexed
  status: 'success' | 'failed' | 'aborted' | 'skipped' | 'crashed';
  error?: string;
  bookedDate?: string;
  bookedTime?: string;
}

export interface BlitzResult {
  success: boolean;
  winningAttempt?: number;   // 1-indexed
  totalAttempted: number;
  totalAborted: number;
  result: BookingResult;
  durationMs: number;
  attempts: AttemptOutcome[]; // per-attempt outcomes (why each one failed)
}

/** Group attempt errors into a compact, human-readable summary. */
export function summarizeFailures(outcomes: AttemptOutcome[]): string {
  const counts = new Map<string, number>();
  for (const o of outcomes) {
    if (o.status === 'success') continue;
    const key = (o.error || o.status).replace(/\s+/g, ' ').trim();
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  if (counts.size === 0) return 'no attempt details captured';
  return Array.from(counts.entries())
    .sort((a, b) => b[1] - a[1])
    .map(([msg, n]) => `${n}× ${msg}`)
    .join('; ');
}

// -- Fingerprint pool for anti-detection --

const USER_AGENTS = [
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.2 Safari/605.1.15',
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:121.0) Gecko/20100101 Firefox/121.0',
];

const VIEWPORTS = [
  { width: 1440, height: 900 },
  { width: 1536, height: 864 },
  { width: 1920, height: 1080 },
  { width: 1366, height: 768 },
  { width: 1280, height: 800 },
];

export function getFingerprint(index: number) {
  return {
    userAgent: USER_AGENTS[index % USER_AGENTS.length],
    viewport: VIEWPORTS[index % VIEWPORTS.length],
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/** Screenshot the page without throwing — used to capture failure state for diagnosis. */
export async function safeShot(page: Page): Promise<string | null> {
  try {
    return (await page.screenshot({ fullPage: false })).toString('base64');
  } catch {
    return null;
  }
}

interface WarmBrowser {
  browser: Browser;
  page: Page;
}

/**
 * Run multiple booking attempts in parallel, staggered around a drop time.
 *
 * Strategy:
 * 1. Pre-launch all browsers and navigate to the search page (warming up)
 * 2. At each staggered offset around the drop time, RELOAD the page
 * 3. First successful booking aborts the rest
 *
 * The earliest attempt fires ~1-2s before the drop to account for latency.
 */
export async function runBlitz(
  req: BookingRequest,
  config: BlitzConfig,
  runAt?: string,
): Promise<BlitzResult> {
  const startTime = Date.now();
  const n = Math.min(Math.max(config.attempts, 1), 5);
  const stagger = config.staggerMs;

  console.log(`\n⚡ BLITZ MODE: ${n} attempts, ${stagger}ms stagger`);
  console.log(`   Restaurant: ${req.restaurant}`);
  console.log(`   Dates: ${req.dates.join(', ')}`);

  // Compute stagger offsets centered around T=0
  // e.g. 3 attempts with 1000ms stagger → [-1000, 0, 1000]
  const offsets: number[] = [];
  for (let i = 0; i < n; i++) {
    offsets.push((i - Math.floor((n - 1) / 2)) * stagger);
  }
  // Shift so earliest is at 0 (we'll handle runAt wait separately)
  const minOffset = Math.min(...offsets);
  const normalizedOffsets = offsets.map(o => o - minOffset);

  console.log(`   Stagger offsets relative to drop: ${offsets.map(o => `${o >= 0 ? '+' : ''}${o}ms`).join(', ')}`);

  const searchUrl = `https://www.exploretock.com/${req.restaurant}/search?date=${req.dates[0]}&size=${req.partySize}&time=${encodeURIComponent(req.time)}`;

  // Phase 1: Pre-launch all browsers, navigate to search page to warm up
  console.log('🔧 Pre-launching and warming up browsers...');
  const warmBrowsers: (WarmBrowser | undefined)[] = [];
  const abortController = new AbortController();
  const { signal } = abortController;

  try {
    const launchResults = await Promise.allSettled(
      Array.from({ length: n }, async (_, i) => {
        const fp = getFingerprint(i);
        const browser = await chromium.launch({ headless: true, args: STEALTH_ARGS });
        const context = await browser.newContext({
          viewport: fp.viewport,
          userAgent: fp.userAgent,
        });

        const cookieCount = await injectCookies(context);
        if (cookieCount === 0) {
          await browser.close();
          throw new Error('No cookies configured');
        }

        const page = await context.newPage();

        // Navigate to search page to warm up (establishes connection, loads assets)
        console.log(`   Browser #${i + 1} navigating to warm up...`);
        await page.goto(searchUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });

        const wb: WarmBrowser = { browser, page };
        warmBrowsers[i] = wb;
        console.log(`   Browser #${i + 1} ready`);
        return wb;
      })
    );

    const launchFailures = launchResults.filter(r => r.status === 'rejected');
    if (launchFailures.length === n) {
      const err = (launchFailures[0] as PromiseRejectedResult).reason;
      const errMsg = err instanceof Error ? err.message : String(err);
      return {
        success: false, totalAttempted: 0, totalAborted: 0,
        result: { success: false, error: `All browsers failed to launch: ${errMsg}` },
        durationMs: Date.now() - startTime,
        attempts: [],
      };
    }
    if (launchFailures.length > 0) {
      console.log(`⚠️ ${launchFailures.length}/${n} browsers failed to warm up, continuing with ${n - launchFailures.length}`);
    }
    console.log(`✅ ${n - launchFailures.length} browsers warmed up`);

    // Phase 2: Wait until drop time, then stagger reload + book attempts
    if (runAt) {
      const targetTime = new Date(runAt).getTime() + minOffset;
      const waitMs = targetTime - Date.now();
      if (waitMs > 0) {
        console.log(`⏳ Waiting ${Math.round(waitMs / 1000)}s until first attempt fires...`);
        await sleep(waitMs);
      }
    }

    let winningAttempt: number | undefined;
    let winningResult: BookingResult | undefined;
    let attempted = 0;
    let aborted = 0;
    const outcomes: AttemptOutcome[] = [];
    const failureShots: string[] = []; // screenshots from failed attempts (for diagnosis)

    const attemptPromises = warmBrowsers.map(async (wb: WarmBrowser | undefined, i: number) => {
      const attemptNum = i + 1;
      if (!wb) {
        console.log(`   Attempt #${attemptNum} skipped (browser warmup failed)`);
        aborted++;
        outcomes.push({ attempt: attemptNum, status: 'skipped', error: 'browser warmup failed' });
        return;
      }

      try {
        // Wait for this attempt's stagger offset + small jitter
        const jitter = Math.floor(Math.random() * 100);
        const delay = normalizedOffsets[i] + jitter;
        if (delay > 0) await sleep(delay);

        if (signal.aborted) {
          aborted++;
          console.log(`   Attempt #${attemptNum} aborted before refresh`);
          outcomes.push({ attempt: attemptNum, status: 'aborted', error: 'aborted before refresh' });
          return;
        }

        attempted++;
        console.log(`\n🏃 Attempt #${attemptNum} refreshing (offset: ${offsets[i] >= 0 ? '+' : ''}${offsets[i]}ms, jitter: +${jitter}ms)`);

        // RELOAD the page — this is the critical moment.
        // The page was already navigated during warmup, so reload fetches
        // fresh data from Tock right at/around the drop time.
        await wb.page.reload({ waitUntil: 'domcontentloaded', timeout: 30000 });

        if (signal.aborted) {
          console.log(`   Attempt #${attemptNum} aborted after refresh`);
          outcomes.push({ attempt: attemptNum, status: 'aborted', error: 'aborted after refresh' });
          return;
        }

        // Now run the booking logic on the refreshed page
        const result = await runBookingFromPage(wb.page, req, signal);

        if (result.success && !signal.aborted) {
          console.log(`\n🏆 Attempt #${attemptNum} SUCCEEDED — aborting others`);
          winningAttempt = attemptNum;
          winningResult = result;
          outcomes.push({ attempt: attemptNum, status: 'success', bookedDate: result.bookedDate, bookedTime: result.bookedTime });
          abortController.abort();
        } else {
          const status: AttemptOutcome['status'] = signal.aborted ? 'aborted' : 'failed';
          if (!signal.aborted) {
            console.log(`   Attempt #${attemptNum} failed: ${result.error}`);
            // Keep this attempt's failure screenshot(s) for post-run diagnosis
            if (result.screenshots?.length) failureShots.push(...result.screenshots);
          }
          outcomes.push({ attempt: attemptNum, status, error: result.error, bookedDate: result.bookedDate, bookedTime: result.bookedTime });
        }
      } catch (err) {
        const error = err instanceof Error ? err.message : String(err);
        console.error(`   Attempt #${attemptNum} crashed:`, error);
        outcomes.push({ attempt: attemptNum, status: 'crashed', error });
      }
    });

    const results = await Promise.allSettled(attemptPromises);
    for (let i = 0; i < results.length; i++) {
      if (results[i].status === 'rejected') {
        console.error(`   Attempt #${i + 1} rejected:`, (results[i] as PromiseRejectedResult).reason);
      }
    }

    const durationMs = Date.now() - startTime;
    outcomes.sort((a, b) => a.attempt - b.attempt);

    if (winningResult) {
      console.log(`\n⚡ Blitz complete: attempt #${winningAttempt} won in ${Math.round(durationMs / 1000)}s`);
      return {
        success: true,
        winningAttempt,
        totalAttempted: attempted,
        totalAborted: aborted,
        result: winningResult,
        durationMs,
        attempts: outcomes,
      };
    }

    const summary = summarizeFailures(outcomes);
    console.log(`\n⚡ Blitz complete: all ${attempted} attempts failed — ${summary}`);
    return {
      success: false,
      totalAttempted: attempted,
      totalAborted: aborted,
      // Surface WHY each attempt failed (grouped) + a few failure screenshots, capped to bound memory.
      result: {
        success: false,
        error: `All ${attempted || n} blitz attempts failed — ${summary}`,
        screenshots: failureShots.slice(0, 3),
      },
      durationMs,
      attempts: outcomes,
    };

  } finally {
    console.log('🧹 Closing all browsers...');
    await Promise.allSettled(
      warmBrowsers.map(wb => wb?.browser?.close())
    );
  }
}

/**
 * Run booking logic on an already-loaded page (post-reload).
 * This is the same flow as runBookingWithContext but skips the initial
 * navigation since the page is already on the search URL.
 */
async function runBookingFromPage(
  page: Page,
  req: BookingRequest,
  signal?: AbortSignal,
): Promise<BookingResult> {
  const screenshots: string[] = [];

  try {
    await page.waitForTimeout(randomDelay(300, 600));

    if (signal?.aborted) return { success: false, error: 'Aborted', screenshots };

    // Wait for calendar to load
    try {
      await page.waitForSelector('.ConsumerCalendar', { state: 'visible', timeout: 15000 });
    } catch {
      const shot = await safeShot(page);
      if (shot) screenshots.push(shot);
      return { success: false, error: 'Calendar did not load after refresh', screenshots };
    }

    if (signal?.aborted) return { success: false, error: 'Aborted', screenshots };

    // Read available dates
    const availableDates = await page.$$eval(
      '.ConsumerCalendar-day.is-available.is-in-month:not(.is-disabled):not(.is-sold)',
      els => els.map(el => el.getAttribute('aria-label')).filter(Boolean) as string[]
    );

    const datesToTry = req.dates.filter(d => availableDates.includes(d));
    if (datesToTry.length === 0) {
      const shot = await safeShot(page);
      if (shot) screenshots.push(shot);
      return { success: false, error: `No dates available. Found: ${availableDates.join(', ') || 'none'}`, screenshots };
    }

    let bookedDate: string | undefined;
    let bookedTime: string | undefined;

    for (const date of datesToTry) {
      if (signal?.aborted) return { success: false, error: 'Aborted', screenshots };

      const dateButton = page.locator(`.ConsumerCalendar-day.is-in-month.is-available[aria-label="${date}"]:not([disabled])`).first();
      await dateButton.scrollIntoViewIfNeeded();
      await dateButton.click();
      await page.waitForTimeout(randomDelay(200, 400));

      try {
        await page.waitForSelector('[data-testid="booking-card-button"]', { timeout: 10000 });
      } catch {
        continue;
      }

      const preferredTime12 = to12Hour(req.time);
      const bookButtons = await page.$$('[data-testid="booking-card-button"]');
      let matchedButton = null;
      let matchedTimeText = '';

      for (const button of bookButtons) {
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

        if (!matchedButton) {
          matchedButton = button;
          matchedTimeText = timeText;
        }
      }

      if (matchedButton) {
        await matchedButton.scrollIntoViewIfNeeded();
        await matchedButton.click();
        bookedDate = date;
        bookedTime = matchedTimeText;
        break;
      }
    }

    if (!bookedDate) {
      const shot = await safeShot(page);
      if (shot) screenshots.push(shot);
      return { success: false, error: 'No time slots found on any date', screenshots };
    }

    if (signal?.aborted) return { success: false, error: 'Aborted', screenshots };

    console.log(`   ✅ Slot grabbed: ${bookedDate} at ${bookedTime}`);

    if (signal?.aborted) return { success: false, bookedDate, bookedTime, error: 'Aborted before purchase', screenshots };

    // Complete the purchase flow
    if (req.autoPurchase !== false) {
      const purchaseResult = await handlePurchaseFlow(page, req.dryRun ?? false, screenshots);
      if (!purchaseResult) {
        try { screenshots.push(await page.screenshot({ fullPage: false }).then(b => b.toString('base64'))); } catch {}
        return { success: false, bookedDate, bookedTime, error: 'Purchase flow failed (see screenshots)', screenshots };
      }
    }

    return { success: true, bookedDate, bookedTime, screenshots };

  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    const shot = await safeShot(page);
    if (shot) screenshots.push(shot);
    return { success: false, error, screenshots };
  }
}
