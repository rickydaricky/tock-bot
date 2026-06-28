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
  // ASSUMPTION (confirmed for prepaid uniform-service venues like Lazy Bear / FHH,
  // unconfirmed for variable-service restaurants — see recon doc): every openTime is
  // valid for every openDate, so we emit the full cross-product. If a venue varied
  // times per date, this could over-emit and a phantom match would burn the lock when
  // grabViaDom finds no enabled button — revisit per-date granularity after a live drop.
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
  dryRun?: boolean;        // rehearse: detect → grab → fill checkout, but DON'T click purchase
}

export interface SniperResult {
  success: boolean;
  bookedDate?: string;
  bookedTime?: string;
  error?: string;
  screenshots?: string[];
  durationMs: number;
  pausedSessionId?: string;
  dryRun?: boolean;        // true when this run rehearsed and did not purchase
  polls: { total: number; matched: number };
}

interface Warm { browser: Browser; page: Page }

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}

function searchUrlFor(req: BookingRequest, date: string): string {
  return `https://www.exploretock.com/${req.restaurant}/search?date=${date}&size=${req.partySize}&time=${encodeURIComponent(req.time)}`;
}

/** Load the search page and read `calendar.offerings` from the live Redux store.
 *  Live recon (2026-06-27): there is NO JSON availability endpoint, and the embedded
 *  `$REDUX_STATE` is a JS object literal (contains `undefined`), so `JSON.parse` on it
 *  fails. Instead we navigate (which Tock/Cloudflare allow — confirmed on Railway via
 *  /api/diag: store hydrates, offerings present) and read `window.store.getState()`.
 *  Returns the offerings object (possibly `{}` when the calendar is empty), null on a
 *  navigation failure, or `{ __noState: true }` if the store never hydrated (challenge
 *  page or a very slow load). Heavier than a raw fetch but correct and proven. */
async function fetchOfferings(page: Page, url: string): Promise<any> {
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
  } catch {
    return null; // navigation failed (network / timeout)
  }
  try {
    await page.waitForFunction(
      () => !!((globalThis as any).window?.store?.getState),
      { timeout: 12000 },
    );
  } catch {
    return { __noState: true }; // never hydrated — challenge page or too slow
  }
  return page.evaluate(() => {
    const st = (globalThis as any).window.store.getState();
    // `offerings` present-but-empty is a valid "nothing yet" state (parseAvailability → []).
    // Only a missing key is a real anomaly.
    if (!st?.calendar || !('offerings' in st.calendar)) return { __noState: true };
    return st.calendar.offerings ?? {};
  });
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
 * search page's embedded availability ($REDUX_STATE) via in-page fetch across the drop window, and let the first
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
      let readablePolls = 0; // dates that returned parseable offerings — distinguishes "sold out" from "blocked"
      try {
        const startAt = base + offsets[i];
        const waitMs = startAt - Date.now();
        if (waitMs > 0) await sleep(waitMs);

        // `<=` so the loop whose start offset equals windowEnd still polls once.
        while (Date.now() <= windowEnd && !lock.won) {
          let slots: NormalizedSlot[] = [];
          let lastErr = '';
          // One navigation per poll: the store's calendar.offerings carries the WHOLE
          // calendar (openDate spans ~3 months), so a single load covers every requested
          // date. We then check each req.date against it below.
          const offerings = await fetchOfferings(w.page, searchUrlFor(req, req.dates[0]));
          if (offerings == null) {
            lastErr = 'page navigation failed (network/timeout)';
          } else if (offerings.__noState) {
            lastErr = 'page did not hydrate (challenge or slow load)';
          } else {
            readablePolls++;
            slots = parseAvailability(offerings, req.partySize);
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
          }
          await sleep(cfg.pollIntervalMs);
        }
        // Distinguish "the restaurant had no availability" from "we never got a readable
        // page" (challenge/block) — otherwise a fully-blocked run looks like a sold-out one.
        if (!lock.won) {
          outcomes.push({ attempt: i + 1, status: 'failed', error: readablePolls === 0
            ? 'availability never readable in window (challenge/block/session)'
            : 'no match in window' });
        }
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

    // --- Phase 3: grab + purchase (or rehearse, if dryRun) ---
    const dryRun = cfg.dryRun ?? false;
    const screenshots: string[] = [];
    const grab = await grabViaDom(winner.page, bookedDate, req.time);
    if (!grab.ok) {
      const shot = await safeShot(winner.page); if (shot) screenshots.push(shot);
      return { success: false, bookedDate, dryRun, error: `Grab failed: ${grab.reason}`, screenshots, durationMs: durationMs(), polls: { total: pollTotal, matched: pollMatched } };
    }
    bookedTime = to12Hour(req.time);

    // handlePurchaseFlow with dryRun=true fills the checkout (add-ons/gratuity/CVC) and
    // stops BEFORE clicking purchase, capturing screenshots — a no-charge rehearsal.
    let purchased = false;
    try {
      purchased = await handlePurchaseFlow(winner.page, dryRun, screenshots);
    } catch (err) {
      outcomes.push({ attempt: 1, status: 'crashed', error: `purchase: ${err instanceof Error ? err.message : String(err)}` });
    }

    if (purchased) {
      console.log(dryRun
        ? `\n🧪 Sniper DRY RUN reached checkout (no purchase): ${bookedDate} ${bookedTime}`
        : `\n🎉 Sniper purchased: ${bookedDate} ${bookedTime}`);
      return { success: true, bookedDate, bookedTime, dryRun, screenshots, durationMs: durationMs(), polls: { total: pollTotal, matched: pollMatched } };
    }

    // A rehearsal that couldn't complete checkout is just a failed test — report it, don't freeze.
    const shot = await safeShot(winner.page); if (shot) screenshots.push(shot);
    if (dryRun) {
      return { success: false, bookedDate, bookedTime, dryRun: true, error: 'Dry run: grabbed the slot but the checkout flow did not complete', screenshots, durationMs: durationMs(), polls: { total: pollTotal, matched: pollMatched } };
    }

    // Real purchase failed: freeze the winning session for human recovery (slot held ~10 min).
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

