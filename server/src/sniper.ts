import { chromium, Browser, Page } from 'playwright';
import { BookingRequest, STEALTH_ARGS, to12Hour, handlePurchaseFlow } from './booker';
import { injectCookies } from './cookies';
import { getFingerprint, summarizeFailures, safeShot, AttemptOutcome } from './blitz';
import { freezeSession } from './sessions';

export interface NormalizedSlot {
  date: string;     // YYYY-MM-DD
  time12: string;   // e.g. "8:00 PM"
  offerId?: string; // offering id from availability, if present
}

/** Exact date+time match. No fuzzy fallback — sniper only grabs what was asked,
 *  so the first-available-time footgun from the old blitz can't surprise-charge. */
export function pickSlot(slots: NormalizedSlot[], date: string, time24: string): NormalizedSlot | null {
  const want = to12Hour(time24).toLowerCase();
  return slots.find(s => s.date === date && s.time12.toLowerCase() === want) ?? null;
}

/** Synchronous compare-and-set. JS is single-threaded, so a sync flag is a
 *  sufficient mutex across concurrent async poll loops: the first loop to find
 *  a slot wins, the rest get false and stop. Prevents duplicate grab/charge. */
export class SingleWinnerLock {
  private claimed = false;
  tryAcquire(): boolean {
    if (this.claimed) return false;
    this.claimed = true;
    return true;
  }
  get won(): boolean { return this.claimed; }
}

/** Evenly spread `pool` poll-loop START offsets across [windowStartMs, windowEndMs]
 *  inclusive (ms relative to runAt). Each loop then polls every pollIntervalMs until
 *  window end, so coverage overlaps and blankets the window. */
export function computeWindowOffsets(pool: number, windowStartMs: number, windowEndMs: number): number[] {
  const n = Math.max(1, pool);
  if (n === 1) return [windowStartMs];
  const span = windowEndMs - windowStartMs;
  return Array.from({ length: n }, (_, i) => windowStartMs + Math.round((span * i) / (n - 1)));
}

/** Normalize a Tock availability response into NormalizedSlot[].
 *  THE ONLY recon-dependent unit. The exact live shape is unconfirmed
 *  (see docs/superpowers/specs/2026-06-26-tock-api-recon.md): the real slot
 *  schema lives in Redux `availability.result`, capturable only live. This
 *  tolerates the shapes seen in saved pages and returns [] on anything
 *  unrecognized — the engine then falls back to reload-on-hit DOM scraping. */
export function parseAvailability(json: unknown): NormalizedSlot[] {
  const out: NormalizedSlot[] = [];
  const root: any = json;
  const days: any[] = Array.isArray(root?.availability) ? root.availability
    : Array.isArray(root?.days) ? root.days
    : [];
  for (const day of days) {
    const date = day?.date ?? day?.businessDate;
    const offers: any[] = Array.isArray(day?.offers) ? day.offers
      : Array.isArray(day?.times) ? day.times
      : [];
    for (const o of offers) {
      const time12 = o?.time ?? o?.display ?? o?.label;
      if (date && time12) {
        out.push({ date: String(date), time12: String(time12), offerId: o?.id ?? o?.offerId });
      }
    }
  }
  return out;
}

export interface SniperConfig {
  pool: number;            // browsers, clamped 1..6
  pollIntervalMs: number;  // per-loop poll cadence
  windowStartMs: number;   // offset vs runAt (e.g. -1000)
  windowEndMs: number;     // offset vs runAt (e.g. +10000)
  maxPrice?: number;       // optional cap (config hook; enforcement TBD — see spec §4.5)
}

export interface SniperResult {
  success: boolean;
  bookedDate?: string;
  bookedTime?: string;
  error?: string;
  screenshots?: string[];
  durationMs: number;
  pausedSessionId?: string;
  polls: { total: number; matched: number };
}

interface Warm { browser: Browser; page: Page; availabilityUrl?: string }

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}

function searchUrlFor(req: BookingRequest, date: string): string {
  return `https://www.exploretock.com/${req.restaurant}/search?date=${date}&size=${req.partySize}&time=${encodeURIComponent(req.time)}`;
}

/** Swap the ?date= param of a captured availability URL to poll another date. */
function withDate(url: string, date: string): string {
  return url.replace(/([?&]date=)[^&]*/, `$1${date}`);
}

/** Fetch availability JSON from inside the page's authenticated context.
 *  Returns the parsed body, or { __status } on a non-OK response, or null on error. */
async function fetchAvailability(page: Page, url: string): Promise<any> {
  return page.evaluate(async (u: string) => {
    try {
      const r = await fetch(u, { credentials: 'include', headers: { accept: 'application/json' } });
      if (!r.ok) return { __status: r.status };
      return await r.json();
    } catch { return null; }
  }, url);
}

/** Reload-on-hit DOM grab: the poller detected a slot via fetch, but the DOM still
 *  shows stale state, so reload once (slot now renders) and click the ENABLED Book
 *  button whose time matches. Fails fast instead of hammering a disabled button. */
async function grabViaDom(page: Page, date: string, time24: string): Promise<boolean> {
  await page.reload({ waitUntil: 'domcontentloaded', timeout: 30000 });
  try {
    await page.waitForSelector('.ConsumerCalendar', { state: 'visible', timeout: 15000 });
  } catch { return false; }

  // Select the date if a date button exists (no-op if already selected).
  const dateBtn = page.locator(`.ConsumerCalendar-day.is-in-month.is-available[aria-label="${date}"]:not([disabled])`).first();
  if (await dateBtn.count().catch(() => 0)) {
    await dateBtn.scrollIntoViewIfNeeded().catch(() => {});
    await dateBtn.click({ timeout: 5000 }).catch(() => {});
    await sleep(400);
  }

  try {
    await page.waitForSelector('[data-testid="booking-card-button"], [data-testid^="offering-book-button"]', { timeout: 10000 });
  } catch { return false; }

  const want = to12Hour(time24).toLowerCase();
  const buttons = await page.$$('[data-testid="booking-card-button"], [data-testid^="offering-book-button"]');
  for (const btn of buttons) {
    if (!(await btn.isEnabled().catch(() => false))) continue; // skip disabled — the hang fix
    const timeText = await btn.evaluate((el: any) => {
      let node = el;
      for (let i = 0; i < 6; i++) {
        node = node?.parentElement || null;
        if (!node) break;
        const m = (node.textContent || '').match(/(\d{1,2}):(\d{2})\s*(AM|PM)/i);
        if (m) return m[0];
      }
      return '';
    });
    if (timeText && timeText.toLowerCase() === want) {
      await btn.scrollIntoViewIfNeeded().catch(() => {});
      await btn.click({ timeout: 5000 });
      return true;
    }
  }
  return false;
}

/**
 * Sniper engine: warm a small browser pool on the search page, densely poll the
 * availability endpoint via in-page fetch across the drop window, and let the first
 * loop to find an EXACT date+time match win an atomic lock, grab the slot
 * (reload-on-hit DOM-click), and auto-purchase. On purchase failure the winning
 * browser is frozen for human recovery; all other browsers are closed.
 */
export async function runSniper(req: BookingRequest, cfg: SniperConfig, runAt?: string): Promise<SniperResult> {
  const startTime = Date.now();
  const pool = Math.min(Math.max(cfg.pool, 1), 6);
  const warm: (Warm | undefined)[] = [];
  const lock = new SingleWinnerLock();
  const outcomes: AttemptOutcome[] = [];
  const failureShots: string[] = [];
  let pollTotal = 0;
  let pollMatched = 0;
  let frozenBrowser: Browser | undefined;

  console.log(`\n🎯 SNIPER: pool=${pool}, interval=${cfg.pollIntervalMs}ms, window=[${cfg.windowStartMs},${cfg.windowEndMs}]ms`);
  console.log(`   ${req.restaurant} | dates ${req.dates.join(', ')} | size ${req.partySize} | ${req.time}`);

  try {
    // --- Phase 1: warm the pool + auto-discover the availability endpoint ---
    await Promise.allSettled(Array.from({ length: pool }, async (_, i) => {
      const fp = getFingerprint(i);
      const browser = await chromium.launch({ headless: true, args: STEALTH_ARGS });
      const context = await browser.newContext({ viewport: fp.viewport, userAgent: fp.userAgent });
      const cookies = await injectCookies(context);
      if (cookies === 0) { await browser.close(); throw new Error('No Tock cookies configured'); }
      const page = await context.newPage();

      let availabilityUrl: string | undefined;
      page.on('response', (resp) => {
        const u = resp.url();
        if (availabilityUrl || !u.includes('/api/') || !u.includes(req.restaurant) && !u.includes('consumer')) return;
        resp.json().then(j => { if (parseAvailability(j).length >= 0 && /availab|search|calendar/i.test(u)) availabilityUrl = u; }).catch(() => {});
      });

      await page.goto(searchUrlFor(req, req.dates[0]), { waitUntil: 'domcontentloaded', timeout: 30000 });
      await sleep(1500); // let the availability XHR fire so the listener can capture it
      warm[i] = { browser, page, availabilityUrl };
      console.log(`   browser #${i + 1} warm${availabilityUrl ? ' (availability endpoint captured)' : ' (DOM fallback)'}`);
    }));

    const live = warm.filter(Boolean) as Warm[];
    if (live.length === 0) {
      return { success: false, error: 'No browsers warmed (cookies missing or all launches failed)', durationMs: Date.now() - startTime, polls: { total: 0, matched: 0 } };
    }

    // --- Phase 2: wait for the window, then poll ---
    const base = runAt ? new Date(runAt).getTime() : Date.now();
    const windowEnd = base + cfg.windowEndMs;
    const offsets = computeWindowOffsets(live.length, cfg.windowStartMs, cfg.windowEndMs);

    let winner: Warm | undefined;
    let bookedDate: string | undefined;
    let bookedTime: string | undefined;

    const loops = live.map(async (w, i) => {
      const startAt = base + offsets[i];
      const waitMs = startAt - Date.now();
      if (waitMs > 0) await sleep(waitMs);

      while (Date.now() < windowEnd && !lock.won) {
        let slots: NormalizedSlot[] = [];
        let lastErr = '';
        if (w.availabilityUrl) {
          const body = await fetchAvailability(w.page, withDate(w.availabilityUrl, req.dates[0]));
          if (body?.__status === 401) { lastErr = 'session expired (401)'; }
          else if (body?.__status === 429) { lastErr = 'throttled (429)'; await sleep(cfg.pollIntervalMs * 3); }
          else if (body) slots = parseAvailability(body);
        } else {
          // DOM fallback: reload + scrape (slower; coarse window coverage)
          try {
            await w.page.reload({ waitUntil: 'domcontentloaded', timeout: 30000 });
            const labels = await w.page.$$eval('.ConsumerCalendar-day.is-available.is-in-month:not(.is-disabled):not(.is-sold)',
              els => els.map(e => e.getAttribute('aria-label')).filter(Boolean) as string[]);
            // Presence of the date in the calendar; time match resolved during grab.
            slots = labels.filter(d => req.dates.includes(d)).map(d => ({ date: d, time12: to12Hour(req.time) }));
          } catch { lastErr = 'reload failed'; }
        }
        pollTotal++;

        let match: NormalizedSlot | null = null;
        for (const d of req.dates) { match = pickSlot(slots, d, req.time); if (match) break; }

        if (match) {
          pollMatched++;
          if (lock.tryAcquire()) {
            winner = w;
            bookedDate = match.date;
            console.log(`\n🏆 Sniper match: ${match.date} ${req.time} (browser #${i + 1}) — grabbing`);
            return;
          }
        } else if (lastErr) {
          outcomes.push({ attempt: i + 1, status: 'failed', error: lastErr });
          if (lastErr.startsWith('session expired')) return; // no point continuing
        }
        await sleep(cfg.pollIntervalMs);
      }
      if (!lock.won) outcomes.push({ attempt: i + 1, status: 'failed', error: 'no match in window' });
    });

    await Promise.all(loops);
    const durationMs = () => Date.now() - startTime;

    if (!winner || !bookedDate) {
      return { success: false, error: `No matching slot in window — ${summarizeFailures(outcomes) || 'none seen'}`, durationMs: durationMs(), polls: { total: pollTotal, matched: pollMatched } };
    }

    // --- Phase 3: grab + blind auto-purchase ---
    const screenshots: string[] = [];
    const grabbed = await grabViaDom(winner.page, bookedDate, req.time);
    if (!grabbed) {
      const shot = await safeShot(winner.page); if (shot) screenshots.push(shot);
      return { success: false, bookedDate, error: 'Slot vanished before grab (lost the race)', screenshots, durationMs: durationMs(), polls: { total: pollTotal, matched: pollMatched } };
    }
    bookedTime = to12Hour(req.time);

    let purchased = false;
    try {
      purchased = await handlePurchaseFlow(winner.page, false, screenshots);
    } catch (err) {
      outcomes.push({ attempt: 0, status: 'crashed', error: err instanceof Error ? err.message : String(err) });
    }

    if (purchased) {
      console.log(`\n🎉 Sniper purchased: ${bookedDate} ${bookedTime}`);
      return { success: true, bookedDate, bookedTime, screenshots, durationMs: durationMs(), polls: { total: pollTotal, matched: pollMatched } };
    }

    // Purchase failed: freeze the winning session for human recovery (slot still held ~10 min).
    const shot = await safeShot(winner.page); if (shot) screenshots.push(shot);
    frozenBrowser = winner.browser;
    const pausedSessionId = freezeSession({
      handle: { browser: winner.browser, page: winner.page },
      restaurant: req.restaurant, bookedDate, bookedTime,
      error: 'purchase failed after grab',
    });
    console.log(`\n⚠️ Sniper grabbed but purchase failed — session frozen (${pausedSessionId})`);
    return { success: false, bookedDate, bookedTime, error: 'Grabbed the slot but purchase failed — session frozen for recovery', screenshots, pausedSessionId, durationMs: durationMs(), polls: { total: pollTotal, matched: pollMatched } };

  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : String(err), durationMs: Date.now() - startTime, polls: { total: pollTotal, matched: pollMatched } };
  } finally {
    // Close every browser EXCEPT the one handed off to a frozen session.
    await Promise.allSettled(warm.map(w => (w && w.browser !== frozenBrowser) ? w.browser.close() : Promise.resolve()));
  }
}

