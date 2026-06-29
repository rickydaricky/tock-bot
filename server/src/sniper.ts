import { chromium, Browser, Page } from 'playwright';
import { BookingRequest, STEALTH_ARGS, to12Hour, handlePurchaseFlow } from './booker';
import { injectCookies } from './cookies';
import { getFingerprint, summarizeFailures, safeShot, AttemptOutcome } from './blitz';
import { freezeSession } from './sessions';

export interface NormalizedSlot {
  date: string;        // YYYY-MM-DD
  time24: string;      // 24h "HH:MM" (for window/closeness math)
  time12: string;      // e.g. "8:00 PM" (for the DOM grab, which matches displayed text)
  offerId?: string;    // offering id from availability, if present
  priceCents?: number; // per-person price in cents, if known (for the cap)
}

/** Minutes-of-day for a 24h "HH:MM" string. */
export function timeToMin(t24: string): number {
  const [h, m] = String(t24).split(':').map(Number);
  return (h || 0) * 60 + (m || 0);
}

/** Exact date+time match (strict mode). Kept for the strict option + tests. */
export function pickSlot(slots: NormalizedSlot[], date: string, time24: string): NormalizedSlot | null {
  const want = to12Hour(time24).toLowerCase();
  return slots.find(s => s.date === date && s.time12.toLowerCase() === want) ?? null;
}

export interface PickOpts {
  windowStart24?: string;  // earliest acceptable time, 24h (default: no lower bound)
  windowEnd24?: string;    // latest acceptable time, 24h (default: no upper bound)
  maxPriceCents?: number;  // reject slots whose KNOWN *total* exceeds this (default: no cap)
  partySize?: number;      // multiplier for the per-person priceCents → total (default: 1)
}

/** Exact DATE, flexible TIME. For the first requested date (priority order) that has a
 *  candidate, return the slot CLOSEST to the target time, restricted to an optional time
 *  window and price cap. Never returns a different date than requested (anti-wrong-date
 *  guard). The price cap compares the estimated TOTAL (per-person `priceCents` × party
 *  size) against `maxPriceCents` — the same TOTAL basis the purchase-time guard uses
 *  (booker.handlePurchaseConfirmation reads the actual "Amount due"). This is only a soft
 *  pre-filter: a slot whose price is UNKNOWN is allowed through here, and the offering
 *  price may omit fees/tax, so the authoritative overspend guard is at purchase time. */
export function pickBestSlot(
  slots: NormalizedSlot[],
  dates: string[],
  targetTime24: string,
  opts: PickOpts = {},
): NormalizedSlot | null {
  const target = timeToMin(targetTime24);
  const lo = opts.windowStart24 ? timeToMin(opts.windowStart24) : -Infinity;
  const hi = opts.windowEnd24 ? timeToMin(opts.windowEnd24) : Infinity;
  const party = opts.partySize ?? 1;
  for (const date of dates) {
    const cands = slots.filter(s => {
      if (s.date !== date) return false;
      const min = timeToMin(s.time24);
      if (min < lo || min > hi) return false;
      if (opts.maxPriceCents != null && s.priceCents != null && s.priceCents * party > opts.maxPriceCents) return false;
      return true;
    });
    if (!cands.length) continue;
    cands.sort((a, b) => Math.abs(timeToMin(a.time24) - target) - Math.abs(timeToMin(b.time24) - target));
    return cands[0];
  }
  return null;
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
export interface TockExperience {
  id: number | string;
  state?: string;
  partySize?: number[];
  price?: { partyRangeConfigs?: Array<{ ticketPriceInformation?: { amountCents?: number } }> };
  ticketPriceInformation?: { amountCents?: number };
}
export interface TockOfferings {
  openDate?: string[];   // bookable dates, "YYYY-MM-DD"
  openTime?: string[];   // bookable times, 24h "HH:MM"
  experience?: TockExperience[];
}

/** Per-person price in cents for an offering, from whichever shape Tock used; undefined if absent. */
export function experiencePriceCents(e: TockExperience): number | undefined {
  return e?.price?.partyRangeConfigs?.[0]?.ticketPriceInformation?.amountCents
    ?? e?.ticketPriceInformation?.amountCents
    ?? undefined;
}

/** Build the bookable slots for a party size from Tock's `calendar.offerings`.
 *  A slot is bookable when its date is in `openDate`, its time in `openTime`, AND at
 *  least one `experience` is `AVAILABLE` for that party size. Carries both 24h and 12h
 *  time plus the per-person price (for the cap). Returns [] if nothing is bookable. */
export function parseAvailability(offerings: unknown, partySize: number): NormalizedSlot[] {
  const o = offerings as TockOfferings | null;
  const dates = Array.isArray(o?.openDate) ? o!.openDate : [];
  const times24 = Array.isArray(o?.openTime) ? o!.openTime : [];
  const bookable = (Array.isArray(o?.experience) ? o!.experience : [])
    .filter(e => e?.state === 'AVAILABLE' && Array.isArray(e?.partySize) && e.partySize!.includes(partySize));
  if (!dates.length || !times24.length || !bookable.length) return [];
  const offerId = String(bookable[0].id);
  const priceCents = experiencePriceCents(bookable[0]);
  const out: NormalizedSlot[] = [];
  // ASSUMPTION (holds for prepaid uniform-service venues like Lazy Bear / FHH; unconfirmed
  // for variable-service restaurants): every openTime is valid for every openDate, so we
  // emit the cross-product. Over-emitting is caught downstream — pickBestSlot won't match a
  // time the grab can't click, and grabViaDom fails fast on a phantom.
  for (const date of dates) {
    for (const t of times24) {
      out.push({ date: String(date), time24: String(t), time12: to12Hour(String(t)), offerId, priceCents });
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
  // --- matching (exact date, flexible time) ---
  timeWindowStart24?: string; // earliest acceptable seating time, 24h (default: any)
  timeWindowEnd24?: string;   // latest acceptable seating time, 24h (default: any)
  maxPriceCents?: number;     // hard cap on the *total* (per-person × party + fees/tax): soft
                              // pre-filter in detection, and abort purchase if the actual
                              // "Amount due" exceeds it. Omit for no cap.
}

/** Validate a sniper config's money/time fields BEFORE warming any browser. Returns an
 *  error message, or null if the config is safe to run. Centralized so BOTH entry points
 *  (the /api/sniper route and the scheduler, which passes the raw config straight to
 *  runSniper) get the same guard — a malformed cap must never silently disable overspend
 *  protection (NaN → comparisons are all false) or silently block every booking (0/""). */
export function validateSniperConfig(cfg: SniperConfig): string | null {
  if (cfg.maxPriceCents != null) {
    if (typeof cfg.maxPriceCents !== 'number' || !Number.isFinite(cfg.maxPriceCents) || cfg.maxPriceCents <= 0) {
      return `maxPriceCents must be a positive number of cents (got ${JSON.stringify(cfg.maxPriceCents)})`;
    }
  }
  for (const [k, v] of [['timeWindowStart24', cfg.timeWindowStart24], ['timeWindowEnd24', cfg.timeWindowEnd24]] as const) {
    if (v != null && !/^\d{1,2}:\d{2}$/.test(v)) {
      return `${k} must be 24h "HH:MM" (got ${JSON.stringify(v)})`;
    }
  }
  return null;
}

/** What the bot actually SAW — so a miss is never a black box. */
export interface SniperSeen {
  datesSeen: string[];        // distinct openDate values observed across polls
  anyTargetDate: boolean;     // was any requested date ever bookable?
  targetDateTimes: string[];  // distinct times (24h) seen on the requested date(s)
  priceCentsSeen?: number;    // a per-person price observed (for sanity vs the cap)
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
  seen?: SniperSeen;       // instrumentation: what availability the bot observed
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
 * search page's embedded availability ($REDUX_STATE) across the drop window, and let the
 * first loop to find a matching slot (EXACT date, closest in-window time, price-capped)
 * win an atomic lock, grab it (reload-on-hit DOM-click), and auto-purchase. Records what
 * it saw for diagnosis. On purchase failure the winning browser is frozen for recovery.
 */
export async function runSniper(req: BookingRequest, cfg: SniperConfig, runAt?: string): Promise<SniperResult> {
  const startTime = Date.now();

  // Fail-closed config gate (covers both the API route AND the scheduler's raw passthrough):
  // never warm a browser — let alone reach a purchase — on a config that can't enforce its cap.
  const cfgError = validateSniperConfig(cfg);
  if (cfgError) {
    console.error(`❌ Sniper config rejected: ${cfgError}`);
    return { success: false, error: `Invalid sniper config: ${cfgError}`, durationMs: Date.now() - startTime, polls: { total: 0, matched: 0 } };
  }
  // Normalize the cap to an integer cents value (validation guarantees it's a positive number).
  const maxPriceCents = cfg.maxPriceCents == null ? undefined : Math.round(cfg.maxPriceCents);

  const pool = Math.min(Math.max(cfg.pool, 1), 6);
  const warm: (Warm | undefined)[] = [];
  const lock = new SingleWinnerLock();
  const outcomes: AttemptOutcome[] = [];
  const failureShots: string[] = [];
  let pollTotal = 0;
  let pollMatched = 0;
  let frozenBrowser: Browser | undefined;

  // --- instrumentation: what the bot actually saw (so a miss is never a black box) ---
  const seenDates = new Set<string>();
  const seenTimesOnTarget = new Set<string>();
  let priceCentsSeen: number | undefined;
  const buildSeen = (): SniperSeen => ({
    datesSeen: [...seenDates].sort().slice(0, 60),
    anyTargetDate: req.dates.some(d => seenDates.has(d)),
    targetDateTimes: [...seenTimesOnTarget].sort(),
    priceCentsSeen,
  });

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
    let winnerSlot: NormalizedSlot | undefined;
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

          // Instrument every poll: record what availability was actually visible.
          for (const s of slots) {
            seenDates.add(s.date);
            if (req.dates.includes(s.date)) seenTimesOnTarget.add(s.time24);
            if (s.priceCents != null) priceCentsSeen = s.priceCents;
          }

          // Exact DATE, flexible TIME (closest to target, within window + total price cap).
          const match = pickBestSlot(slots, req.dates, req.time, {
            windowStart24: cfg.timeWindowStart24,
            windowEnd24: cfg.timeWindowEnd24,
            maxPriceCents,
            partySize: req.partySize,
          });

          if (match) {
            pollMatched++;
            if (lock.tryAcquire()) {
              winner = w;
              winnerSlot = match;
              bookedDate = match.date;
              console.log(`\n🏆 Sniper match: ${match.date} ${match.time12} (target ${req.time}, browser #${i + 1}) — grabbing`);
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
    const seen = buildSeen();

    if (!winner || !bookedDate || !winnerSlot) {
      // No match — capture what one browser sees + the structured `seen` data, so we know
      // whether the target date/time was ever present (vs sold-out vs blocked). No black box.
      const shot = live[0] ? await safeShot(live[0].page) : null;
      const why = seen.anyTargetDate
        ? `requested date was bookable but no time matched (window ${cfg.timeWindowStart24 ?? 'any'}–${cfg.timeWindowEnd24 ?? 'any'}); times seen on target date: [${seen.targetDateTimes.join(', ') || 'none'}]`
        : 'requested date never became bookable in the window';
      console.log(`\n❌ Sniper no match — ${why}`);
      return { success: false, error: `No matching slot in window — ${why} · ${summarizeFailures(outcomes)}`, durationMs: durationMs(), polls: { total: pollTotal, matched: pollMatched }, seen, screenshots: shot ? [shot] : undefined };
    }

    // --- Phase 3: grab + purchase (or rehearse, if dryRun) ---
    const dryRun = cfg.dryRun ?? false;
    const screenshots: string[] = [];
    const grab = await grabViaDom(winner.page, bookedDate, winnerSlot.time24);
    if (!grab.ok) {
      const shot = await safeShot(winner.page); if (shot) screenshots.push(shot);
      return { success: false, bookedDate, bookedTime: winnerSlot.time12, dryRun, error: `Grab failed: ${grab.reason}`, screenshots, durationMs: durationMs(), polls: { total: pollTotal, matched: pollMatched }, seen };
    }
    bookedTime = winnerSlot.time12;

    // handlePurchaseFlow with dryRun=true fills the checkout (add-ons/gratuity/CVC) and
    // stops BEFORE clicking purchase, capturing screenshots — a no-charge rehearsal.
    // handlePurchaseFlow with dryRun=true fills the checkout and STOPS before clicking
    // purchase. With maxPriceCents set, it also aborts (returns false) if the actual amount
    // due on the confirm page exceeds the cap — the real overspend guard.
    let purchased = false;
    let purchaseErr = '';
    try {
      purchased = await handlePurchaseFlow(winner.page, dryRun, screenshots, maxPriceCents);
    } catch (err) {
      purchaseErr = err instanceof Error ? err.message : String(err);
      outcomes.push({ attempt: 1, status: 'crashed', error: `purchase: ${purchaseErr}` });
    }

    if (purchased) {
      console.log(dryRun
        ? `\n🧪 Sniper DRY RUN reached checkout (no purchase): ${bookedDate} ${bookedTime}`
        : `\n🎉 Sniper purchased: ${bookedDate} ${bookedTime}`);
      return { success: true, bookedDate, bookedTime, dryRun, screenshots, durationMs: durationMs(), polls: { total: pollTotal, matched: pollMatched }, seen };
    }

    // A rehearsal (or a price-capped/failed checkout) didn't complete — report it, don't freeze.
    const shot = await safeShot(winner.page); if (shot) screenshots.push(shot);
    if (dryRun) {
      return { success: false, bookedDate, bookedTime, dryRun: true, error: `Dry run: grabbed the slot but checkout did not complete${purchaseErr ? ' — ' + purchaseErr : ''}`, screenshots, durationMs: durationMs(), polls: { total: pollTotal, matched: pollMatched }, seen };
    }

    // Real purchase failed: freeze the winning session for human recovery (slot held ~10 min).
    frozenBrowser = winner.browser;
    const pausedSessionId = freezeSession({
      handle: { browser: winner.browser, page: winner.page },
      restaurant: req.restaurant, bookedDate, bookedTime,
      error: 'purchase failed after grab',
    });
    console.log(`\n⚠️ Sniper grabbed but purchase failed — session frozen (${pausedSessionId})`);
    return { success: false, bookedDate, bookedTime, error: 'Grabbed the slot but purchase failed — session frozen for recovery', screenshots, pausedSessionId, durationMs: durationMs(), polls: { total: pollTotal, matched: pollMatched }, seen };

  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : String(err), durationMs: Date.now() - startTime, polls: { total: pollTotal, matched: pollMatched } };
  } finally {
    // Close every browser EXCEPT the one handed off to a frozen session.
    await Promise.allSettled(warm.map(w => (w && w.browser !== frozenBrowser) ? w.browser.close() : Promise.resolve()));
  }
}

