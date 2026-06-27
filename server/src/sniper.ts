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

/** Tock's `calendar.offerings`, extracted from the search page's embedded
 *  `$REDUX_STATE` (confirmed by live recon 2026-06-27 — see the recon doc).
 *  There is NO JSON availability endpoint; this is the real slot source. */
export interface TockOfferings {
  openDate?: string[];   // bookable dates, "YYYY-MM-DD"
  openTime?: string[];   // bookable times, 24h "HH:MM"
  experience?: Array<{ id: number | string; state?: string; partySize?: number[] }>;
}

/** Build the bookable slots for a party size from Tock's `calendar.offerings`.
 *  A slot is bookable when its date is in `openDate`, its time in `openTime`, AND
 *  at least one `experience` is `AVAILABLE` for that party size. `openTime` is 24h
 *  and is converted to the 12h form `pickSlot` matches on. Returns [] if nothing
 *  is bookable (e.g. all experiences SOLD, or wrong party size). */
export function parseAvailability(offerings: unknown, partySize: number): NormalizedSlot[] {
  const o = offerings as TockOfferings | null;
  const dates = Array.isArray(o?.openDate) ? o!.openDate : [];
  const times24 = Array.isArray(o?.openTime) ? o!.openTime : [];
  const bookable = (Array.isArray(o?.experience) ? o!.experience : [])
    .filter(e => e?.state === 'AVAILABLE' && Array.isArray(e?.partySize) && e.partySize!.includes(partySize));
  if (!dates.length || !times24.length || !bookable.length) return [];
  const offerId = String(bookable[0].id);
  const out: NormalizedSlot[] = [];
  for (const date of dates) {
    for (const t of times24) {
      out.push({ date: String(date), time12: to12Hour(String(t)), offerId });
    }
  }
  return out;
}

export interface SniperConfig {
  pool: number;            // browsers, clamped 1..6
  pollIntervalMs: number;  // per-loop poll cadence
  windowStartMs: number;   // offset vs runAt (e.g. -1000)
  windowEndMs: number;     // offset vs runAt (e.g. +10000)
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

interface Warm { browser: Browser; page: Page }

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}

function searchUrlFor(req: BookingRequest, date: string): string {
  return `https://www.exploretock.com/${req.restaurant}/search?date=${date}&size=${req.partySize}&time=${encodeURIComponent(req.time)}`;
}

/** Fetch the search page HTML from inside the page's authenticated context, extract
 *  the embedded `window.$REDUX_STATE`, and return `calendar.offerings`. Live recon
 *  (2026-06-27) confirmed there is NO JSON availability endpoint — availability is
 *  server-rendered into the page, so polling means re-fetching this HTML. Returns the
 *  offerings object, `{ __status }` on a non-OK response, `{ __noState: true }` if the
 *  state couldn't be parsed (e.g. a Cloudflare challenge), or null on a thrown error. */
async function fetchOfferings(page: Page, url: string): Promise<any> {
  return page.evaluate(async (u: string) => {
    try {
      const r = await fetch(u, { credentials: 'include' });
      if (!r.ok) return { __status: r.status };
      const html = await r.text();
      const marker = '$REDUX_STATE = ';
      const start = html.indexOf(marker);
      if (start < 0) return { __noState: true };
      const i = start + marker.length;
      if (html[i] !== '{') return { __noState: true };
      // Brace-match the JSON object (string-aware) to find where it ends.
      let depth = 0, inStr = false, esc = false, end = -1;
      for (let j = i; j < html.length; j++) {
        const c = html[j];
        if (inStr) { if (esc) esc = false; else if (c === '\\') esc = true; else if (c === '"') inStr = false; }
        else if (c === '"') inStr = true;
        else if (c === '{') depth++;
        else if (c === '}') { if (--depth === 0) { end = j + 1; break; } }
      }
      if (end < 0) return { __noState: true };
      const state = JSON.parse(html.slice(i, end));
      return (state.calendar && state.calendar.offerings) || { __noState: true };
    } catch { return null; }
  }, url);
}

export type GrabResult = { ok: true } | { ok: false; reason: string };

/** Reload-on-hit DOM grab: the poller detected a slot via fetch, but the DOM still
 *  shows stale state, so reload once (slot now renders) and click the ENABLED Book
 *  button whose time matches. Fails fast instead of hammering a disabled button.
 *  Returns a discriminated reason so the caller can distinguish a genuine lost race
 *  from a stale-session/page error. */
async function grabViaDom(page: Page, date: string, time24: string): Promise<GrabResult> {
  await page.reload({ waitUntil: 'domcontentloaded', timeout: 30000 });
  try {
    await page.waitForSelector('.ConsumerCalendar', { state: 'visible', timeout: 15000 });
  } catch { return { ok: false, reason: 'calendar did not render (stale session or blocked page?)' }; }

  // Select the date if a date button exists (no-op if already selected).
  const dateBtn = page.locator(`.ConsumerCalendar-day.is-in-month.is-available[aria-label="${date}"]:not([disabled])`).first();
  if (await dateBtn.count().catch(() => 0)) {
    await dateBtn.scrollIntoViewIfNeeded().catch(() => {});
    const clicked = await dateBtn.click({ timeout: 5000 }).then(() => true).catch(() => false);
    if (!clicked) console.warn(`   ⚠️ grab: date button click for ${date} did not land; proceeding`);
    await sleep(400);
  }

  try {
    await page.waitForSelector('[data-testid="booking-card-button"], [data-testid^="offering-book-button"]', { timeout: 10000 });
  } catch { return { ok: false, reason: 'no booking buttons rendered for the date' }; }

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
      try { await btn.click({ timeout: 5000 }); }
      catch { return { ok: false, reason: 'matched slot button click failed' }; }
      return { ok: true };
    }
  }
  return { ok: false, reason: 'no enabled slot matched the requested time (lost the race)' };
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
    // --- Phase 1: warm the pool (land on the exploretock.com origin so the poller's
    // same-origin fetch carries the session cookies) ---
    const warmResults = await Promise.allSettled(Array.from({ length: pool }, async (_, i) => {
      const browser = await chromium.launch({ headless: true, args: STEALTH_ARGS });
      try {
        const fp = getFingerprint(i);
        const context = await browser.newContext({ viewport: fp.viewport, userAgent: fp.userAgent });
        const cookies = await injectCookies(context);
        if (cookies === 0) throw new Error('No Tock cookies configured');
        const page = await context.newPage();
        await page.goto(searchUrlFor(req, req.dates[0]), { waitUntil: 'domcontentloaded', timeout: 30000 });
        warm[i] = { browser, page };
        console.log(`   browser #${i + 1} warm`);
      } catch (e) {
        await browser.close().catch(() => {}); // no leak on cookie/nav failure
        throw e;
      }
    }));

    const warmFailures = warmResults.filter(r => r.status === 'rejected') as PromiseRejectedResult[];
    for (const f of warmFailures) console.error(`   ⚠️ warm-up failed: ${f.reason instanceof Error ? f.reason.message : f.reason}`);
    const live = warm.filter(Boolean) as Warm[];
    console.log(`   warmed ${live.length}/${pool} browsers`);
    if (live.length === 0) {
      const why = warmFailures[0]?.reason;
      return { success: false, error: `No browsers warmed: ${why instanceof Error ? why.message : why ?? 'unknown'}`, durationMs: Date.now() - startTime, polls: { total: 0, matched: 0 } };
    }

    // --- Phase 2: wait for the window, then poll ---
    const base = runAt ? new Date(runAt).getTime() : Date.now();
    const windowEnd = base + cfg.windowEndMs;
    const offsets = computeWindowOffsets(live.length, cfg.windowStartMs, cfg.windowEndMs);

    let winner: Warm | undefined;
    let bookedDate: string | undefined;
    let bookedTime: string | undefined;

    const loops = live.map(async (w, i) => {
      try {
        const startAt = base + offsets[i];
        const waitMs = startAt - Date.now();
        if (waitMs > 0) await sleep(waitMs);

        // `<=` so the loop whose start offset equals windowEnd still polls once.
        while (Date.now() <= windowEnd && !lock.won) {
          const slots: NormalizedSlot[] = [];
          let lastErr = '';
          // Poll EVERY requested date (priority order). Each poll re-fetches the search
          // HTML and reads calendar.offerings (no JSON endpoint exists — see recon).
          for (const d of req.dates) {
            const offerings = await fetchOfferings(w.page, searchUrlFor(req, d));
            if (offerings == null) { lastErr = 'availability fetch failed (network/in-page error)'; break; }
            if (offerings.__status === 401) { lastErr = 'session expired (401)'; break; }
            if (offerings.__status === 429) { lastErr = 'throttled (429)'; await sleep(cfg.pollIntervalMs * 3); break; }
            if (typeof offerings.__status === 'number') { lastErr = `availability HTTP ${offerings.__status}`; break; } // 403 anti-bot, 5xx
            if (offerings.__noState) { lastErr = 'could not parse availability (challenge or layout change)'; continue; }
            slots.push(...parseAvailability(offerings, req.partySize));
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
            if (lastErr.startsWith('session expired')) return; // unrecoverable within the window
          }
          await sleep(cfg.pollIntervalMs);
        }
        if (!lock.won) outcomes.push({ attempt: i + 1, status: 'failed', error: 'no match in window' });
      } catch (err) {
        // One crashed browser must not abort the others or discard an existing winner.
        outcomes.push({ attempt: i + 1, status: 'crashed', error: err instanceof Error ? err.message : String(err) });
      }
    });

    await Promise.allSettled(loops);
    const durationMs = () => Date.now() - startTime;

    if (!winner || !bookedDate) {
      return { success: false, error: `No matching slot in window — ${summarizeFailures(outcomes)}`, durationMs: durationMs(), polls: { total: pollTotal, matched: pollMatched } };
    }

    // --- Phase 3: grab + blind auto-purchase ---
    const screenshots: string[] = [];
    const grab = await grabViaDom(winner.page, bookedDate, req.time);
    if (!grab.ok) {
      const shot = await safeShot(winner.page); if (shot) screenshots.push(shot);
      return { success: false, bookedDate, error: `Grab failed: ${grab.reason}`, screenshots, durationMs: durationMs(), polls: { total: pollTotal, matched: pollMatched } };
    }
    bookedTime = to12Hour(req.time);

    let purchased = false;
    try {
      purchased = await handlePurchaseFlow(winner.page, false, screenshots);
    } catch (err) {
      outcomes.push({ attempt: 1, status: 'crashed', error: `purchase: ${err instanceof Error ? err.message : String(err)}` });
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

