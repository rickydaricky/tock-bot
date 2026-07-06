/**
 * opentable/blitz.ts — Blitz mode for OpenTable: N parallel booking attempts
 * staggered around the drop moment, using independent browser contexts each
 * armed with their own fingerprint (UA + viewport) and OpenTable session cookies.
 *
 * Mirrors the Tock blitz (`src/blitz.ts`) but adapts to the OpenTable API shape:
 * - `runOpenTableBookingWithContext` takes a BrowserContext and navigates internally,
 *   so we warm N contexts (not pages) and let each attempt create its own page.
 * - Cookie injection uses platform 'opentable'.
 */
import { chromium, Browser, BrowserContext } from 'playwright';
import { BookingRequest, BookingResult, STEALTH_ARGS } from '../booker';
import { BlitzConfig, BlitzResult, AttemptOutcome, getFingerprint, summarizeFailures } from '../blitz';
import { injectCookies } from '../cookies';
import { buildOpenTableSearchUrl } from './url';
import { runOpenTableBookingWithContext } from './booker';

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

interface WarmContext {
  browser: Browser;
  context: BrowserContext;
}

/**
 * Run N independent OpenTable booking attempts in parallel, staggered around a drop.
 *
 * Strategy:
 * 1. Pre-launch N browsers; each gets a distinct fingerprint + OpenTable cookies.
 *    A warm navigation is done per context to establish Akamai/session clearance.
 * 2. At each staggered offset around runAt, call runOpenTableBookingWithContext
 *    (which creates its own page and navigates) — no page reload needed.
 * 3. First success aborts the rest via a shared AbortController.
 */
export async function runOpenTableBlitz(
  req: BookingRequest,
  config: BlitzConfig,
  runAt?: string,
): Promise<BlitzResult> {
  const startTime = Date.now();
  const n = Math.min(Math.max(config.attempts, 1), 5);
  const stagger = config.staggerMs;

  // Compute stagger offsets centered around T=0 (e.g. 3 attempts @ 1000ms → [-1000, 0, +1000])
  const offsets: number[] = [];
  for (let i = 0; i < n; i++) {
    offsets.push((i - Math.floor((n - 1) / 2)) * stagger);
  }
  const minOffset = Math.min(...offsets);
  const normalizedOffsets = offsets.map(o => o - minOffset);

  console.log(`\n⚡ [OT] BLITZ MODE: ${n} attempts, ${stagger}ms stagger`);
  console.log(`   Restaurant: ${req.restaurant}`);
  console.log(`   Stagger offsets: ${offsets.map(o => `${o >= 0 ? '+' : ''}${o}ms`).join(', ')}`);

  const warmContexts: (WarmContext | undefined)[] = [];
  const abortController = new AbortController();

  try {
    // Phase 1: Launch all browsers, warm each context with OpenTable cookies + a pre-navigation.
    console.log('🔧 [OT] Pre-launching and warming contexts...');
    const launchResults = await Promise.allSettled(
      Array.from({ length: n }, async (_, i) => {
        const fp = getFingerprint(i);
        const browser = await chromium.launch({ headless: true, channel: 'chromium', args: STEALTH_ARGS });
        const context = await browser.newContext({
          viewport: fp.viewport,
          userAgent: fp.userAgent,
          locale: 'en-US',
          timezoneId: 'America/Los_Angeles',
        });

        const cookieCount = await injectCookies(context, 'opentable');
        if (cookieCount === 0) {
          await browser.close();
          throw new Error('No OpenTable cookies configured');
        }

        // Warm navigation — establishes Akamai/session clearance so the booking attempt
        // doesn't hit a bot-challenge on its first request. The page is closed after
        // warmup; runOpenTableBookingWithContext will open its own page in the same context.
        const warmUrl = buildOpenTableSearchUrl(req.restaurant, req.dates[0], req.time, req.partySize);
        const page = await context.newPage();
        try {
          await page.goto(warmUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
        } finally {
          await page.close();
        }

        console.log(`   [OT] Context #${i + 1} warmed (${cookieCount} cookies)`);
        warmContexts[i] = { browser, context };
      })
    );

    const allFailed = launchResults.every(r => r.status === 'rejected');
    if (allFailed) {
      const err = (launchResults[0] as PromiseRejectedResult).reason;
      return {
        success: false,
        totalAttempted: 0,
        totalAborted: 0,
        result: {
          success: false,
          error: `All OpenTable browsers failed to warm: ${err instanceof Error ? err.message : String(err)}`,
        },
        durationMs: Date.now() - startTime,
        attempts: [],
      };
    }

    const warmFailures = launchResults.filter(r => r.status === 'rejected').length;
    if (warmFailures > 0) {
      console.log(`⚠️ [OT] ${warmFailures}/${n} contexts failed to warm; continuing with ${n - warmFailures}`);
    } else {
      console.log(`✅ [OT] All ${n} contexts warmed`);
    }

    // Phase 2: Wait until the first attempt should fire (runAt + minOffset).
    // minOffset is the earliest offset (negative for centered stagger), so waiting
    // until runAt + minOffset fires the earliest attempt slightly before the drop.
    if (runAt) {
      const waitMs = new Date(runAt).getTime() + minOffset - Date.now();
      if (waitMs > 0) {
        console.log(`⏳ [OT] Waiting ${Math.round(waitMs / 1000)}s until first attempt fires...`);
        await sleep(waitMs);
      }
    }

    // Phase 3: Staggered booking attempts. Each attempt calls runOpenTableBookingWithContext
    // which creates its own page and navigates — no reload needed.
    let winningResult: BookingResult | undefined;
    let winningAttempt: number | undefined;
    let attempted = 0;
    let aborted = 0;
    const outcomes: AttemptOutcome[] = [];

    await Promise.allSettled(
      warmContexts.map(async (wc, i) => {
        const attemptNum = i + 1;

        if (!wc) {
          aborted++;
          outcomes.push({ attempt: attemptNum, status: 'skipped', error: 'browser warmup failed' });
          return;
        }

        try {
          // Stagger delay + small jitter to avoid perfectly-uniform timing (bot tell).
          const jitter = Math.floor(Math.random() * 100);
          const delay = normalizedOffsets[i] + jitter;
          if (delay > 0) await sleep(delay);

          if (abortController.signal.aborted) {
            aborted++;
            outcomes.push({ attempt: attemptNum, status: 'aborted', error: 'aborted before booking' });
            return;
          }

          attempted++;
          console.log(`\n🏃 [OT] Attempt #${attemptNum} starting (offset: ${offsets[i] >= 0 ? '+' : ''}${offsets[i]}ms, jitter: +${jitter}ms)`);

          const r = await runOpenTableBookingWithContext(wc.context, req, abortController.signal);

          if (r.success && !abortController.signal.aborted) {
            console.log(`\n🏆 [OT] Attempt #${attemptNum} SUCCEEDED — aborting others`);
            winningResult = r;
            winningAttempt = attemptNum;
            outcomes.push({ attempt: attemptNum, status: 'success', bookedDate: r.bookedDate, bookedTime: r.bookedTime });
            abortController.abort();
          } else {
            const status: AttemptOutcome['status'] = abortController.signal.aborted ? 'aborted' : 'failed';
            if (!abortController.signal.aborted) {
              console.log(`   [OT] Attempt #${attemptNum} failed: ${r.error}`);
            }
            outcomes.push({ attempt: attemptNum, status, error: r.error, bookedDate: r.bookedDate, bookedTime: r.bookedTime });
          }
        } catch (err) {
          const error = err instanceof Error ? err.message : String(err);
          console.error(`   [OT] Attempt #${attemptNum} crashed:`, error);
          outcomes.push({ attempt: attemptNum, status: 'crashed', error });
        }
      })
    );

    const durationMs = Date.now() - startTime;
    outcomes.sort((a, b) => a.attempt - b.attempt);

    if (winningResult) {
      console.log(`\n⚡ [OT] Blitz complete: attempt #${winningAttempt} won in ${Math.round(durationMs / 1000)}s`);
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
    console.log(`\n⚡ [OT] Blitz complete: all ${attempted} attempts failed — ${summary}`);
    return {
      success: false,
      totalAttempted: attempted,
      totalAborted: aborted,
      result: {
        success: false,
        error: `All ${attempted || n} OpenTable blitz attempts failed — ${summary}`,
      },
      durationMs,
      attempts: outcomes,
    };
  } finally {
    console.log('🧹 [OT] Closing all browsers...');
    await Promise.allSettled(warmContexts.map(wc => wc?.browser.close()));
  }
}
