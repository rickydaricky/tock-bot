/**
 * sniper.ts — THE core reservation SNIPER engine.
 *
 * Responsibility: win a competitive Tock reservation "drop". Warm a small headless browser
 * pool on the search page, densely poll the page's embedded availability ($REDUX_STATE →
 * calendar.offerings) across the drop window, and — the instant a matching slot appears
 * (EXACT date, closest in-window time, price-capped) — let a single poll loop win an atomic
 * lock and GRAB the slot, then auto-purchase (or rehearse, under dryRun). Every run records
 * what it actually saw so a miss is diagnosable, and a held-but-uncompleted slot is frozen
 * for manual recovery rather than lost.
 *
 * Grab has two paths, tried in order:
 *   1. Direct-API lock (primary, Cloudflare-proof): PUT /api/ticket/group/lock with a
 *      reverse-engineered protobuf body (encodeTockLock), issued via an in-page fetch that
 *      reuses the warm session's cf_clearance + captured/reconstructed x-tock-* headers.
 *      No document navigation ⇒ it never draws the Turnstile challenge a reload would.
 *   2. Hybrid reload+click (fallback): reload the search page and click the ENABLED Book
 *      button for the matched time (reaches checkout via the client-side flow that paid
 *      experiences require; also handles multi-seating chooser + wrong-slot guards).
 *
 * Load-bearing invariants / reverse-engineered facts:
 *   - Fail-closed price cap: a real (non-dry) run REQUIRES maxPriceCents. The soft detection
 *     filter can let unknown-price slots through; the AUTHORITATIVE overspend guard is at
 *     purchase time against the actual "Amount due" (handlePurchaseFlow).
 *   - Single-winner lock: exactly one loop grabs/charges even with many overlapping loops.
 *   - The lock PUT returns HTTP 200 for BOTH a real hold AND a conflict — the body must be
 *     classified (lockResponseVerdict: a hold echoes reservation details ~1200B+; a conflict
 *     is a short "no longer available" ~89B), or a taken slot reads as a win.
 *   - There is NO JSON availability endpoint: the only slot source is the JS-literal
 *     $REDUX_STATE embedded in the search HTML (extractOfferingsFromHtml surgically parses it).
 *   - x-tock-* headers are reused, not forged: captured from the app's own requests, else
 *     reconstructed byte-equal from page state (readTockHeadersFromPage) for modal-UI venues.
 *
 * Key exports: runSniper (the engine); SniperConfig / SniperResult / NormalizedSlot /
 * GrabResult (the contracts); and the pure, unit-tested helpers — parseAvailability,
 * extractOfferingsFromHtml, pickBestSlot, encodeTockLock, lockResponseVerdict,
 * computeWindowOffsets, SingleWinnerLock, validateSniperConfig.
 */
import { chromium, Browser, Page } from 'playwright';
import { BookingRequest, STEALTH_ARGS, to12Hour, handlePurchaseFlow } from './booker';
import { injectCookies } from './cookies';
import { getFingerprint, summarizeFailures, safeShot, AttemptOutcome } from './blitz';
import { freezeSession } from './sessions';
import { calibrateClock, t0Epoch, computeFireAt } from './clock';
import { notifyHeld } from './notify';

/** One bookable slot, normalized from Tock's raw availability into the single shape the
 *  sniper matches, grabs, and price-caps against. Both time formats are carried on purpose:
 *  time24 for window/closeness arithmetic, time12 because that's the literal text the DOM
 *  grab clicks. offerId/seatingAreaId/priceCents feed the direct-API lock and the cap. */
export interface NormalizedSlot {
  date: string;        // YYYY-MM-DD
  time24: string;      // 24h "HH:MM" (for window/closeness math)
  time12: string;      // e.g. "8:00 PM" (for the DOM grab, which matches displayed text)
  offerId?: string;    // experience id from availability — also the lock's experienceId
  priceCents?: number; // per-person price in cents, if known (for the cap)
  seatingAreaId?: number; // first seating area id (multi-seating venues); absent = direct-book
}

/** Minutes-of-day for a 24h "HH:MM" string. */
export function timeToMin(t24: string): number {
  const [h, m] = String(t24).split(':').map(Number);
  return (h || 0) * 60 + (m || 0);
}

/** Minutes-of-day for a 12h "H:MM AM/PM" card label, or null if it doesn't parse. */
export function time12ToMin(t12: string): number | null {
  const m = String(t12).match(/(\d{1,2}):(\d{2})\s*(AM|PM)/i);
  if (!m) return null;
  let h = Number(m[1]) % 12;
  if (m[3].toUpperCase() === 'PM') h += 12;
  return h * 60 + Number(m[2]);
}

/** When the originally matched time's button is gone at grab (sold in the detect→reload
 *  gap, or a calendar cross-product false positive — openTime[] is global, not per-date),
 *  choose the closest surviving in-window time instead of losing the whole run. Times are
 *  the 12h card labels; ties go to the earlier slot. Null when nothing in-window survives. */
export function pickFallbackTime12(times12: string[], target24: string, winStart24?: string, winEnd24?: string): string | null {
  const target = timeToMin(target24);
  const lo = winStart24 ? timeToMin(winStart24) : -Infinity;
  const hi = winEnd24 ? timeToMin(winEnd24) : Infinity;
  let best: string | null = null;
  let bestMin = 0;
  for (const t of times12) {
    const min = time12ToMin(t);
    if (min == null || min < lo || min > hi) continue;
    if (best === null
      || Math.abs(min - target) < Math.abs(bestMin - target)
      || (Math.abs(min - target) === Math.abs(bestMin - target) && min < bestMin)) {
      best = t;
      bestMin = min;
    }
  }
  return best;
}

/** Exact date+time match (strict mode). Kept for the strict option + tests. */
export function pickSlot(slots: NormalizedSlot[], date: string, time24: string): NormalizedSlot | null {
  const want = to12Hour(time24).toLowerCase();
  return slots.find(s => s.date === date && s.time12.toLowerCase() === want) ?? null;
}

/** Optional constraints for pickBestSlot: an acceptable seating-time window plus a total
 *  price cap (per-person `priceCents` × `partySize`). All fields absent = accept any slot on
 *  the requested date. Kept separate from SniperConfig so the picker stays pure/testable. */
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
  seatingArea?: Array<{ id?: number | string }>; // present on multi-seating venues (JouJou); [] direct-book (FHH)
}
/** Tock's `calendar.offerings` object: parallel arrays of every bookable date and time for
 *  the venue, plus the experiences. parseAvailability cross-products dates × times, gated by
 *  an AVAILABLE experience for the party size, into concrete NormalizedSlots. */
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
  // First seating area id, if the venue is multi-seating (needed by the direct-API lock).
  // A raw number, or {id}. Absent/[] for direct-book venues like FHH.
  const rawSeat = bookable[0].seatingArea?.[0];
  const seatingAreaId = rawSeat == null ? undefined
    : Number(typeof rawSeat === 'object' ? (rawSeat as { id?: number | string }).id : rawSeat);
  const seat = Number.isFinite(seatingAreaId as number) ? (seatingAreaId as number) : undefined;
  const out: NormalizedSlot[] = [];
  // ASSUMPTION (holds for prepaid uniform-service venues like Lazy Bear / FHH; unconfirmed
  // for variable-service restaurants): every openTime is valid for every openDate, so we
  // emit the cross-product. Over-emitting is caught downstream — pickBestSlot won't match a
  // time the grab can't click, and grabViaDom fails fast on a phantom.
  for (const date of dates) {
    for (const t of times24) {
      const slot: NormalizedSlot = { date: String(date), time24: String(t), time12: to12Hour(String(t)), offerId, priceCents };
      if (seat !== undefined) slot.seatingAreaId = seat;
      out.push(slot);
    }
  }
  return out;
}

/** All runtime knobs for one sniper run: pool size + poll cadence + drop-window bounds, the
 *  match constraints (time window, price cap), and the two read/grab path toggles (fastPoll,
 *  apiGrab). Passed straight through by BOTH entry points — the /api/sniper route and the
 *  scheduler's raw passthrough — so it MUST be run through validateSniperConfig before any
 *  browser is warmed (a malformed cap must never silently disable the overspend guard). */
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
  fastPoll?: boolean;         // use the in-page-fetch fast read path (default true). Set false
                              // to force the slower navigate path (A/B or if fast is throttled).
  apiGrab?: boolean;          // grab via the direct-API lock (default true) — Cloudflare-proof,
                              // no reload. Set false to force the legacy reload+click grab.
  // --- T0 Volley Fire (§1,§3,§4,§6): pre-fired authenticated lock volley for sub-second drops ---
  volleyFire?: boolean;       // engage the T0 Volley engine (default false → legacy poll path).
                              // When true: pre-encode the wanted cells during warm-up, calibrate
                              // to Tock's clock, and at the observed drop edge fire an in-page burst
                              // of PUT /lock across the drop window until one returns HELD.
  wantedTimes24?: string[];   // the operator's target seating times (24h "HH:MM"), best-time-first
                              // is derived from closeness to req.time. Absent ⇒ fall back to req.time.
  wantedDates?: string[];     // the operator's target dates (priority order); a backup date's cells
                              // never sort ahead of any primary-date cell. Absent ⇒ fall back to req.dates.
  fireLeadMs?: number;        // ms to fire BEFORE the edge so the packet ARRIVES at the origin at
                              // the open instant (computeFireAt subtracts min(RTT, leadMs)). Default 0.
  reFireMs?: number;          // per-cell re-fire cadence during the sustain window (~50–80ms). Bounded
                              // aggregate rate is the anti-WAF lever (§5). Default 60.
  volleyDeadlineMs?: number;  // how long (ms after ignition) to sustain the barrage before giving up
                              // (~30s per §2.2). Default 30_000.
  fixedExperienceId?: number; // fallback experienceId when the T−3s recon reads nothing (SOLD/empty
                              // next-week grid). FHH: 559289.
  fixedPrepaidCents?: number; // fallback per-person prepaid price (f6) for the same case. FHH: 25800.
  fixedSeatingAreaId?: number;// f13 seating-area id for MULTI-SEATING volley venues (e.g. a JouJou
                              // rehearsal). Omit for direct-book venues like FHH — the lock carries no f13.
  f6Candidates?: number[];    // optional low-priority price-fan: extra plausible season prices to fire
                              // as a secondary wave against price drift (§3.3.2). Never wins over the
                              // primary f6; a speculative HELD still hits the cap + attribution guard.
}

/** Validate a sniper config's money/time fields BEFORE warming any browser. Returns an
 *  error message, or null if the config is safe to run. Centralized so BOTH entry points
 *  (the /api/sniper route and the scheduler, which passes the raw config straight to
 *  runSniper) get the same guard — a malformed cap must never silently disable overspend
 *  protection (NaN → comparisons are all false) or silently block every booking (0/""). */
export function validateSniperConfig(cfg: SniperConfig): string | null {
  // A real (non-dry) run without a cap has no overspend guard — reject at every gate
  // (schedule time, request time, and fire time) rather than discover it at the drop.
  if (!cfg.dryRun && cfg.maxPriceCents == null) {
    return 'maxPriceCents is required for a real (non-dry) sniper run — set a total price cap or enable dryRun';
  }
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
  // --- Volley-mode bounds. A malformed cadence/deadline could spin a zero-interval barrage
  // (WAF suicide, §5) or a negative deadline (fires zero times), so gate them at the same
  // fail-closed boundary the cap uses. The time lists must be well-formed 24h strings; the
  // ids/prices must be positive finite numbers. Volley mode itself doesn't relax the cap —
  // maxPriceCents is still required above unless dryRun (the manual freeze path FHH lands on). ---
  for (const [k, v] of [['wantedTimes24', cfg.wantedTimes24], ['wantedDates', cfg.wantedDates]] as const) {
    if (v != null && !Array.isArray(v)) return `${k} must be an array of strings (got ${JSON.stringify(v)})`;
  }
  for (const t of cfg.wantedTimes24 ?? []) {
    if (typeof t !== 'string' || !/^\d{1,2}:\d{2}$/.test(t)) return `wantedTimes24 entries must be 24h "HH:MM" (got ${JSON.stringify(t)})`;
  }
  for (const d of cfg.wantedDates ?? []) {
    if (typeof d !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(d)) return `wantedDates entries must be "YYYY-MM-DD" (got ${JSON.stringify(d)})`;
  }
  // fireLeadMs may be 0 (fire exactly at the edge); the rest must be strictly positive so a
  // stray 0/NaN can't collapse the sustain loop into a busy-spin or a no-op.
  for (const [k, v, minInclusive] of [
    ['fireLeadMs', cfg.fireLeadMs, 0],
    ['reFireMs', cfg.reFireMs, 1],
    ['volleyDeadlineMs', cfg.volleyDeadlineMs, 1],
    ['fixedExperienceId', cfg.fixedExperienceId, 1],
    ['fixedPrepaidCents', cfg.fixedPrepaidCents, 0],
  ] as const) {
    if (v == null) continue;
    if (typeof v !== 'number' || !Number.isFinite(v) || v < minInclusive) {
      return `${k} must be a ${minInclusive === 0 ? 'non-negative' : 'positive'} finite number (got ${JSON.stringify(v)})`;
    }
  }
  if (cfg.f6Candidates != null) {
    if (!Array.isArray(cfg.f6Candidates)) return `f6Candidates must be an array of positive cent amounts (got ${JSON.stringify(cfg.f6Candidates)})`;
    for (const c of cfg.f6Candidates) {
      if (typeof c !== 'number' || !Number.isFinite(c) || c < 0) return `f6Candidates entries must be non-negative finite cent amounts (got ${JSON.stringify(c)})`;
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

/** Outcome of a sniper run: success + what was booked, or a diagnosable failure. Always
 *  carries poll accounting and the `seen` instrumentation (so a miss is never a black box);
 *  `pausedSessionId` is set only when a slot was HELD but not completed and the winning
 *  browser was frozen for manual recovery (slot survives ~10 min). */
export interface SniperResult {
  success: boolean;
  bookedDate?: string;
  bookedTime?: string;
  error?: string;
  screenshots?: string[];
  durationMs: number;
  pausedSessionId?: string;
  dryRun?: boolean;        // true when this run rehearsed and did not purchase
  // `fast`/`nav` = polls served by the fast in-page-fetch vs the navigate fallback;
  // `challenges` = polls where the fast fetch hit a Cloudflare challenge (throttle signal).
  polls: { total: number; matched: number; fast?: number; nav?: number; challenges?: number };
  seen?: SniperSeen;       // instrumentation: what availability the bot observed
}

/** A warmed pool member: a live browser + page already past Cloudflare on the exploretock.com
 *  origin (so an in-page fetch carries session cookies + cf_clearance), plus the x-tock-*
 *  header set the direct-API lock needs. `headerSource` records HOW those headers were obtained
 *  ('request' = captured from the app's own calls, 'page'/'page-grab' = reconstructed from page
 *  state, 'none' = never got them) — surfaced verbatim in failure diagnostics. `tockHeaderHits`
 *  counts x-tock-bearing requests seen (0 ⇒ modal-UI venue that fired none passively). */
interface Warm { browser: Browser; page: Page; tockHeaders?: Record<string, string>; tockHeaderHits?: number; headerSource?: 'request' | 'page' | 'page-grab' | 'none' }

/** Attach a request listener that keeps the latest x-tock-* header set the APP puts on its
 *  own API calls (x-tock-session/fingerprint are stable per session). We reuse these on the
 *  direct-API lock instead of forging the anti-bot fingerprint.
 *  Capture from ANY same-origin request carrying x-tock-session — modal-UI restaurants
 *  (n/naka, FHH) fire these on /api/graphql/* at load but may not fire /api/consumer/offerings
 *  passively, so restricting to consumer/ticket missed them (observed live 2026-07-05). */
function captureTockHeaders(page: Page, sink: Warm): void {
  page.on('request', r => {
    const h = r.headers();
    if (!h['x-tock-session'] || !/exploretock\.com/.test(r.url())) return;
    sink.tockHeaderHits = (sink.tockHeaderHits ?? 0) + 1;
    sink.tockHeaders = Object.fromEntries(Object.entries(h).filter(([k]) => k.startsWith('x-tock-')));
  });
}

/** Fallback header source: reconstruct the x-tock-* set directly from page state, for
 *  modal-UI restaurants (n/naka, FHH) that fire NO x-tock request during passive warm-up on
 *  the authenticated server (confirmed 2026-07-05: 0 x-tock reqs seen). session lives in
 *  sessionStorage, fingerprint in localStorage, businessId/build/experiments in the embedded
 *  state — all verified byte-equal to the real headers the app sends. Returns null if the
 *  essential session/fingerprint aren't present yet. */
async function readTockHeadersFromPage(page: Page): Promise<Record<string, string> | null> {
  return page.evaluate(() => {
    const g: any = globalThis;
    const strip = (s: string | null) => (s || '').replace(/^"|"$/g, '');
    const session = strip(g.sessionStorage?.getItem('tock_session'));
    const fingerprint = strip(g.localStorage?.getItem('fingerprint'));
    if (!session || !fingerprint) return null;
    const html: string = g.document.documentElement.outerHTML;
    const m = (re: RegExp) => (html.match(re) || [])[1];
    const build = (html.match(/servingstack-[\w.-]+/) || [])[0] || '';
    const bid = m(/"businessId"\s*:\s*"?(\d+)"?/) || m(/\\"businessId\\":\s*\\?"?(\d+)/) || '';
    const gid = m(/"businessGroupId"\s*:\s*"?(\d+)"?/) || m(/\\"businessGroupId\\":\s*\\?"?(\d+)/) || '';
    const exp = (html.match(/WidgetBusinessNeighborhood:[^"'\\]+/) || [])[0] || '';
    const h: Record<string, string> = {
      'x-tock-session': session,
      'x-tock-fingerprint': fingerprint,
      'x-tock-stream-format': 'proto2',
      'x-tock-path': g.location.pathname,
      'x-tock-scope': JSON.stringify({ businessId: bid ? Number(bid) : undefined, businessGroupId: gid || undefined, site: 'EXPLORETOCK' }),
      'x-tock-metro-area-id': '10',
    };
    if (build) h['x-tock-build-number'] = build;
    if (exp) h['x-tock-experimentvariantlist'] = exp;
    return h;
  }).catch(() => null);
}

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** The Tock search-page URL for a date — both the pool's warm target and the poller's read
 *  target. Any requested date works as the read target since the embedded offerings covers the
 *  venue's whole ~3-month calendar (so one fetch per poll checks every requested date). */
function searchUrlFor(req: BookingRequest, date: string): string {
  return `https://www.exploretock.com/${req.restaurant}/search?date=${date}&size=${req.partySize}&time=${encodeURIComponent(req.time)}`;
}

/** String-aware scan for the index of the brace that closes the object opening at the first
 *  `{` at/after `openIdx`. Braces inside double/single-quoted strings are ignored, so nested
 *  objects and braces-in-strings don't truncate the match. Returns -1 if unbalanced. */
function matchObjectEnd(s: string, openIdx: number): number {
  let depth = 0, inStr = false, q = '', esc = false;
  for (let k = openIdx; k < s.length; k++) {
    const c = s[k];
    if (inStr) {
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === q) inStr = false;
    } else if (c === '"' || c === "'") { inStr = true; q = c; }
    else if (c === '{') depth++;
    else if (c === '}') { if (--depth === 0) return k; }
  }
  return -1;
}

/** Replace value-position `undefined` (outside strings) with `null`, turning a JS-literal
 *  subtree into valid JSON. Tock's `offerings` subtree contains bare `undefined` (68 of them
 *  in a live sample) but — unlike the wider $REDUX_STATE — NO functions, so this normalization
 *  + JSON.parse is sufficient and needs no eval. String-aware so an `undefined` inside a quoted
 *  value (none observed, but cheap insurance) is never touched. */
function jsUndefinedToNull(sub: string): string {
  let out = '', inStr = false, q = '', esc = false;
  for (let i = 0; i < sub.length; i++) {
    const c = sub[i];
    if (inStr) {
      out += c;
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === q) inStr = false;
    } else if (c === '"' || c === "'") { inStr = true; q = c; out += c; }
    else if (sub.startsWith('undefined', i)) { out += 'null'; i += 'undefined'.length - 1; }
    else out += c;
  }
  return out;
}

/** FAST availability parse: surgically pull just the `"offerings":{…}` subtree out of the
 *  embedded `$REDUX_STATE` JS literal in a Tock search page's HTML and JSON-parse it. The full
 *  literal can't be JSON.parsed — it embeds functions (e.g. `"onClose":function…`), which is
 *  why the original poller navigated + read `window.store` instead. But the offerings subtree
 *  is pure availability data, so extracting just it (anchored after `"calendar":`) and
 *  normalizing `undefined`→`null` parses cleanly. CSP-safe (no eval) and pure (unit-tested).
 *  Returns the offerings object (possibly `{}`), or null if the marker/subtree is absent or
 *  unparseable (caller falls back to the navigate path). */
export function extractOfferingsFromHtml(html: string): any | null {
  const mi = html.indexOf('$REDUX_STATE');
  if (mi < 0) return null;
  const litStart = html.indexOf('{', html.indexOf('=', mi));
  if (litStart < 0) return null;
  const litEnd = matchObjectEnd(html, litStart);
  if (litEnd < 0) return null;
  const lit = html.slice(litStart, litEnd + 1);
  const calIdx = lit.indexOf('"calendar":');           // anchor so we get calendar.offerings
  const oi = lit.indexOf('"offerings":', calIdx >= 0 ? calIdx : 0);
  if (oi < 0) return null;
  const os = lit.indexOf('{', oi);
  if (os < 0) return null;
  const oe = matchObjectEnd(lit, os);
  if (oe < 0) return null;
  try {
    return JSON.parse(jsUndefinedToNull(lit.slice(os, oe + 1)));
  } catch {
    return null;
  }
}

/** FAST offerings read: from a WARM (already Cloudflare-cleared) page, do a same-origin in-page
 *  `fetch` of the search HTML — it carries cf_clearance so Cloudflare serves the real page (no
 *  new challenge, confirmed live) — and parse the offerings subtree. ~3-4× faster than a full
 *  navigation (skips the document lifecycle + hydration): ~0.5s vs ~1.9s/poll. Returns the
 *  offerings object, `{ __challenge: true }` if Cloudflare served a challenge, `{ __noState:
 *  true }` if the offerings couldn't be parsed, or null if the fetch threw. */
async function fetchOfferingsFast(page: Page, url: string): Promise<any> {
  let html: string | null;
  try {
    html = await page.evaluate(async (u) => {
      const r = await fetch(u, { credentials: 'include' });
      return await r.text();
    }, url);
  } catch {
    return null; // fetch threw in-page (navigated away / network)
  }
  if (!html) return null;
  if (/just a moment|challenge-platform|cf-chl|_cf_chl/i.test(html)) return { __challenge: true };
  return extractOfferingsFromHtml(html) ?? { __noState: true };
}

/** Per-loop fast-path state: whether the fast in-page-fetch read is still enabled for this
 *  loop, and the running count of consecutive misses that latches it off (readOfferings). */
interface FastState { useFast: boolean; fastFails: number; }
/** Per-run poll accounting by read path — fast hits, navigate fallbacks, and Cloudflare
 *  challenges (a throttle signal) — surfaced in SniperResult.polls. */
interface PathStats { fast: number; nav: number; challenges: number; }

/** One availability read: try the FAST in-page-fetch path first; on any non-offerings result
 *  (challenge / unparseable / threw) fall back to the proven navigate path for THIS poll (so no
 *  poll is wasted) and, after 2 consecutive fast misses, latch fast off for the rest of this
 *  loop (avoid paying fetch+navigate every poll). Never regresses below the navigate path. */
async function readOfferings(page: Page, url: string, st: FastState, stats: PathStats): Promise<any> {
  if (st.useFast) {
    const fast = await fetchOfferingsFast(page, url);
    if (fast && fast.__challenge) { stats.challenges++; st.fastFails++; }
    else if (fast != null && !fast.__noState) { stats.fast++; st.fastFails = 0; return fast; }
    else { st.fastFails++; }
    if (st.useFast && st.fastFails >= 2) {
      st.useFast = false;
      console.warn('   ⚠️ fast poll path disabled (2 consecutive misses) — using navigate fallback');
    }
  }
  const nav = await fetchOfferingsViaNavigate(page, url);
  stats.nav++;
  return nav;
}

/** Load the search page and read `calendar.offerings` from the live Redux store.
 *  Live recon (2026-06-27): there is NO JSON availability endpoint, and the embedded
 *  `$REDUX_STATE` is a JS object literal (contains `undefined`), so `JSON.parse` on it
 *  fails. Instead we navigate (which Tock/Cloudflare allow — confirmed on Railway via
 *  /api/diag: store hydrates, offerings present) and read `window.store.getState()`.
 *  Returns the offerings object (possibly `{}` when the calendar is empty), null on a
 *  navigation failure, or `{ __noState: true }` if the store never hydrated (challenge
 *  page or a very slow load). Heavier than a raw fetch but correct and proven — used as
 *  the FALLBACK when the fast in-page-fetch path (fetchOfferingsFast) can't parse. */
async function fetchOfferingsViaNavigate(page: Page, url: string): Promise<any> {
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

/** Post-click hold decision from what the page shows. Pure so it's unit-testable:
 *  checkout markers or having left the search page = the hold started; still on search
 *  with Tock's "no longer available" message = we lost the click race (retryable);
 *  neither yet = keep waiting. */
export function holdStateFromPage(hasCheckout: boolean, takenMsg: boolean, onSearch: boolean): 'held' | 'taken' | 'pending' {
  if (hasCheckout || !onSearch) return 'held';
  if (takenMsg) return 'taken';
  return 'pending';
}

/** After the Book (+ seating) click, verify the hold actually started. A button can be
 *  rendered enabled yet already taken — Tock then shows "this time slot is no longer
 *  available" (owner-observed) WITHOUT navigating, which previously burned the full 30s
 *  purchase-flow timeout and ended the run. Poll briefly; a lost click race is reported
 *  as retryable within ~2s instead. Inconclusive → treat as held (handlePurchaseFlow's
 *  30s gate still applies — this check can only fail fast, never falsely abort). */
async function verifyHoldStarted(page: Page): Promise<'held' | 'taken'> {
  const deadline = Date.now() + 6000;
  while (Date.now() < deadline) {
    let st: { hasCheckout: boolean; takenMsg: boolean; onSearch: boolean };
    try {
      st = await page.evaluate(() => {
        const d = (globalThis as any).document;
        return {
          hasCheckout: !!d.querySelector('[data-testid="supplement-group-confirm-button"], [data-testid="supplement-page-view-order"], [data-testid="purchase-button"]'),
          takenMsg: /no longer available/i.test(d.body?.innerText || ''),
          onSearch: /\/search/.test((globalThis as any).location?.pathname || ''),
        };
      });
    } catch (err) {
      // Mid-navigation context destruction — checkout is loading. (A dead page lands
      // here too; handlePurchaseFlow's throw-on-timeout reports it loudly right after.)
      console.log(`   ⏳ hold-verify evaluate threw (${errMsg(err)}) — treating as navigation`);
      return 'held';
    }
    const state = holdStateFromPage(st.hasCheckout, st.takenMsg, st.onSearch);
    if (state !== 'pending') return state;
    await sleep(300);
  }
  return 'held'; // inconclusive — let the purchase flow's own gate decide
}

/** Result of one grab attempt (either the API or the reload+click path). Note the two
 *  non-obvious cases: an `ok:true` with `heldNoCheckout` means the slot is genuinely LOCKED
 *  but checkout wasn't auto-reached (freeze for manual completion — do NOT treat as failure);
 *  and an `ok:false` with `slotTakenAtClick`+`failedTime12` is a RETRYABLE lost click race —
 *  the caller retries the next surviving time with `failedTime12` excluded. */
export type GrabResult =
  | { ok: true; time12?: string; heldNoCheckout?: boolean } // heldNoCheckout: locked but checkout page not auto-reached (rescue manually)
  | { ok: false; reason: string; slotTakenAtClick?: boolean; failedTime12?: string };

/** The date as Tock renders it on the checkout summary (e.g. "2026-07-11" → "July 11, 2026"),
 *  so grabViaApi can confirm the held slot matches the intended date before any purchase. */
export function checkoutDateString(date: string): string | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!m) return null;
  const months = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  const mo = months[Number(m[2]) - 1];
  if (!mo) return null;
  return `${mo} ${Number(m[3])}, ${m[1]}`;
}

/** Walk up from a button to the nearest ancestor whose text contains a slot time, and
 *  return that time (e.g. "7:00 PM"). Stopping at the NEAREST time-bearing ancestor is
 *  what scopes a button to its own card — higher containers hold every card's times and
 *  would match the first card on the page instead.
 *  Serialized into the page by evaluate(): must stay self-contained (no outer references). */
export function nearestTimeText(el: any): string {
  let node = el;
  for (let i = 0; i < 10; i++) {
    node = node?.parentElement || null;
    if (!node) break;
    const m = (node.textContent || '').match(/(\d{1,2}):(\d{2})\s*(AM|PM)/i);
    if (m) return m[0];
  }
  return '';
}

/** Multi-seating experiences don't navigate on Book: the card expands a "Select a seating
 *  option" chooser in place, and every time card on the page expands at once (Tock redux
 *  field `experience.seatingArea`, observed live 2026-07: JouJou non-empty → chooser,
 *  FHH [] → direct book). Click the option scoped to OUR time, or a neighboring card's
 *  option would book the wrong slot. Direct-book restaurants render no seating-area
 *  buttons, so this only costs them the settle sleep (overlapping checkout navigation). */
export async function clickSeatingAreaForTime(page: Page, want12: string): Promise<GrabResult> {
  const want = want12.toLowerCase();

  // Phase 1: settle + query. A throw HERE is plausibly the direct-book flow racing to
  // checkout (execution context destroyed mid-navigation) — treat as success, but say so:
  // handlePurchaseFlow fails loudly right after if the page actually died.
  let areas;
  try {
    await sleep(700); // let the accordion (or checkout navigation) render
    areas = await page.$$('[data-testid^="seating-area-"]');
  } catch (err) {
    console.log(`   🪑 seating-area query threw (${errMsg(err)}) — assuming checkout navigation`);
    return { ok: true };
  }
  if (!areas.length) {
    console.log('   🪑 no seating chooser — direct-book flow');
    return { ok: true };
  }

  // Phase 2: the chooser exists, so Book did NOT navigate — from here every failure is
  // real (a multi-seating slot never reaches checkout without a seating click).
  let visible = 0;
  const timesSeen: string[] = [];
  try {
    for (const area of areas) {
      if (!(await area.isVisible().catch(() => false))) continue;
      visible++;
      const timeText = await area.evaluate(nearestTimeText);
      if (timeText) timesSeen.push(timeText);
      if (timeText && timeText.toLowerCase() === want) {
        const areaId = await area.getAttribute('data-testid').catch(() => null);
        try { await area.click({ timeout: 5000 }); }
        catch (err) { return { ok: false, reason: `seating option click failed: ${errMsg(err)}` }; }
        console.log(`   🪑 Seating chooser: picked ${areaId ?? 'option'} for ${timeText}`);
        return { ok: true };
      }
    }
    return { ok: false, reason: `seating chooser rendered but no option matched — ${areas.length} options, ${visible} visible, times seen [${[...new Set(timesSeen)].join(', ')}], wanted ${want}` };
  } catch (err) {
    return { ok: false, reason: `seating chooser handling failed: ${errMsg(err)}` };
  }
}

/** Encode Tock's `PUT /api/ticket/group/lock` protobuf body (reverse-engineered 2026-07-03).
 *  Outer envelope field 60051 wraps: f1=partySize, f2="YYYY-MM-DDTHH:MM", f3=experienceId,
 *  f6=per-person prepaid price in cents, f13=seatingAreaId (omitted for direct-book venues).
 *  f6 is the ticket price the app sends (Lazy Bear 42000, craft-omakase 18500) — STRICT
 *  restaurants (omakase, and prepaid tasting menus like FHH) reject a wrong/zero price with a
 *  200 "no longer available"; lenient ones accept it. Verified vs real click-generated locks. */
export function encodeTockLock(partySize: number, dateTime: string, experienceId: number, seatingAreaId?: number, prepaidCents = 0): Buffer {
  const w = (arr: number[], n: number) => { let v = Math.floor(n); while (v > 0x7f) { arr.push((v & 0x7f) | 0x80); v = Math.floor(v / 128); } arr.push(v & 0x7f); };
  const field = (arr: number[], f: number, wire: number) => w(arr, f * 8 + wire);
  const inner: number[] = [];
  field(inner, 1, 0); w(inner, partySize);
  field(inner, 2, 2); { const b = Buffer.from(dateTime, 'utf8'); w(inner, b.length); for (const x of b) inner.push(x); }
  field(inner, 3, 0); w(inner, experienceId);
  field(inner, 6, 0); w(inner, Math.max(0, Math.floor(prepaidCents)));
  if (seatingAreaId != null && Number.isFinite(seatingAreaId)) { field(inner, 13, 0); w(inner, seatingAreaId); }
  const outer: number[] = [];
  field(outer, 60051, 2); w(outer, inner.length); for (const x of inner) outer.push(x);
  return Buffer.from(outer);
}

/** One pre-encoded lock candidate: a wanted (date × time) cell with the experience/price it
 *  will PUT, plus the base64 protobuf body ready to fire in-page. `key` is a stable per-cell
 *  identity ("date|time24|experienceId|f6") used by the volley for the at-most-one-in-flight
 *  and re-fire-non-held bookkeeping. `f6` is the per-person prepaid price (cents) baked into
 *  the body; `primary` marks the intended (expId,f6) so a speculative f6-fan hit never wins
 *  over the real one. Bodies sort best-first: primary dates before backup dates, then time
 *  closeness, then primary price before the fan. */
export interface LockCandidate {
  key: string;
  date: string;         // YYYY-MM-DD
  time24: string;       // zero-padded 24h "HH:MM" (matches the lock datetime format exactly)
  experienceId: number;
  f6: number;           // per-person prepaid price in cents baked into the body
  b64: string;          // base64-encoded PUT /lock protobuf, ready for in-page atob()+fetch
  primary: boolean;     // true = the intended (expId,f6); false = a low-priority f6-fan body
}

/** Inputs that a candidate set is built AGAINST — the reconciled/known experience+price and
 *  the operator's wanted grid. Kept separate from SniperConfig so the builder stays pure and
 *  unit-testable: everything drift-sensitive (experienceId/prepaidCents) is passed in, having
 *  been resolved by preDropRecon or the FHH constants at call time. */
export interface CandidateConstants {
  experienceId: number;      // reconciled/known experience id for the drop (FHH: 559289)
  prepaidCents: number;      // reconciled/known per-person prepaid price (f6) (FHH: 25800)
  wantedDates: string[];     // target dates, priority order (primary first)
  wantedTimes24: string[];   // target seating times, 24h (in-window subset resolved by caller)
  seatingAreaId?: number;    // multi-seating venues only (f13); omitted for direct-book (FHH)
  f6Candidates?: number[];   // extra plausible prices for the low-priority fan (§3.3.2)
}

/** Zero-pad a 24h "H:MM"/"HH:MM" to "HH:MM" — the lock datetime must match Tock's format
 *  exactly (a stray "9:00" builds a body the server rejects with a 200 "no longer available",
 *  which would look like a conflict rather than our own bug). Non-parsing input is returned
 *  trimmed so the caller's own validation surfaces it, not a silently-mangled time. */
function padTime24(t24: string): string {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(t24).trim());
  return m ? `${m[1].padStart(2, '0')}:${m[2]}` : String(t24).trim();
}

/** PURE. Pre-encode the lock bodies for the operator's WANTED cells (wantedDates × wantedTimes),
 *  best-first, for the T0 volley to fire. This is the "delete the detect→build gap" step (§1.1):
 *  every body here is ready to leave the wire the instant ignition fires, so no work happens on
 *  the hot path but the fetch itself.
 *
 *  Ordering contract (§4.1 "narrow, serialized claim" + priority): candidates are sorted
 *    1. by DATE priority — a backup date's cell NEVER sorts ahead of any primary-date cell;
 *    2. within a date, by TIME closeness to `req.time` (ties → earlier time);
 *    3. within a cell, PRIMARY (expId,prepaidCents) before any low-priority f6-fan price,
 *  so the volley fires the most-wanted cell first and a speculative price can't out-race the
 *  intended one. The f6-fan (constants.f6Candidates, minus the primary price) is appended per
 *  primary cell as trailing low-priority bodies — never as its own high-priority wave.
 *
 *  Reuses encodeTockLock (byte-verified) so every body is identical to a real click-generated
 *  lock. De-dupes identical (date,time24,experienceId,f6) keys so a wantedTimes list that
 *  repeats or a fan price that equals the primary doesn't fire the same cell twice. */
export function buildCandidateBodies(req: BookingRequest, constants: CandidateConstants): LockCandidate[] {
  const target = timeToMin(req.time);
  const dates = constants.wantedDates.length ? constants.wantedDates : req.dates;
  const times = (constants.wantedTimes24.length ? constants.wantedTimes24 : [req.time]).map(padTime24);
  const seat = constants.seatingAreaId;
  // Primary price first, then any distinct fan prices (fan never contains the primary twice).
  const fan = (constants.f6Candidates ?? []).filter(c => c !== constants.prepaidCents);
  const prices: Array<{ f6: number; primary: boolean }> = [
    { f6: constants.prepaidCents, primary: true },
    ...fan.map(f6 => ({ f6, primary: false })),
  ];

  const out: LockCandidate[] = [];
  const seen = new Set<string>();
  // dates OUTER (index carries priority so a backup date sorts after every primary cell),
  // times INNER sorted by closeness to the target, prices INNERMOST (primary before fan).
  dates.forEach((date, di) => {
    const sortedTimes = [...times].sort((a, b) => {
      const da = Math.abs(timeToMin(a) - target), db = Math.abs(timeToMin(b) - target);
      return da !== db ? da - db : timeToMin(a) - timeToMin(b); // tie → earlier time
    });
    sortedTimes.forEach((time24, ti) => {
      prices.forEach(({ f6, primary }, pi) => {
        const key = `${date}|${time24}|${constants.experienceId}|${f6}`;
        if (seen.has(key)) return;
        seen.add(key);
        const dateTime = `${date}T${time24}`;
        const b64 = encodeTockLock(req.partySize, dateTime, constants.experienceId, seat, f6).toString('base64');
        // Encode the priority into the array order directly (dates outer, times mid, price inner).
        out.push({ key, date, time24, experienceId: constants.experienceId, f6, b64, primary });
        void di; void ti; void pi; // (indices are implicit in the nested-iteration order)
      });
    });
  });
  return out;
}

/** The four outcomes a lock PUT can resolve to (§3.3.4). FAIL-OPEN on wins: a large non-conflict
 *  200 is 'held' — we never downgrade a real lock on an echo comparison, because a held slot we
 *  fail to drive is a silent loss of a slot we actually hold (§C1), and every cell we fire is a
 *  WANTED cell anyway. Attribution is enforced later at checkout (the confirm-page date guard).
 *   - 'rejected' → an ambiguous non-conflict rejection (rate-limit / lock-state / wrong-f6):
 *     NOT the confirmed ~89-byte "no longer available" shape, so it may still be winnable →
 *     KEEP RETRYING, rather than pruning a possibly-open cell.
 *  Only the confirmed conflict shape prunes a cell — this is the fail-open pruning rule. */
export type LockVerdict = 'held' | 'conflict' | 'rejected' | 'blocked';

/** The confirmed conflict phrasing — the ONLY body shape that prunes a cell (fail-open, §3.3.4).
 *  Narrower than the historical `lockResponseVerdict` regex so an ambiguous rejection (which we
 *  want to keep retrying) isn't mistaken for the definitive "someone took it" conflict. */
const CONFLICT_RE = /no longer available|already (taken|selected|booked|reserved|held)|sold\s*out/i;

/** Classify a `PUT /api/ticket/group/lock` response for the VOLLEY (the reference the in-page
 *  fireVolley loop mirrors verbatim). FAIL-OPEN: any large non-conflict 200 is 'held'; the echo is
 *  never used to downgrade a win (§C1). Attribution is a later, authoritative checkout-page guard.
 *
 *  Verdict order (widest-prune-last so we never over-prune):
 *   - non-200 or HTML interstitial             → 'blocked'
 *   - confirmed "no longer available" phrasing → 'conflict'  (the ONLY pruning verdict)
 *   - large body (≥150B)                       → 'held'
 *   - anything else (small non-conflict 200)   → 'rejected' (ambiguous → keep retrying) */
export function classifyLock(
  status: number,
  contentType: string,
  len: number,
  text: string,
): LockVerdict {
  if (status !== 200 || /html/i.test(contentType || '')) return 'blocked';
  // Only the CONFIRMED conflict phrasing prunes — an ambiguous rejection stays retryable.
  if (CONFLICT_RE.test(text || '')) return 'conflict';
  // A real lock: any large non-conflict body is a win. We do NOT inspect the echo here — the
  // response echoes the offering base time, not our slot, so an echo check false-rejects wins.
  if (len >= 150) return 'held';
  // Small, 200, no confirmed-conflict marker: rate-limit / lock-state / wrong-f6 → keep trying.
  return 'rejected';
}

/** Parse the datetime + experienceId a lock RESPONSE echoes — DIAGNOSTIC ONLY (§C1). It never
 *  gates a win; fireVolley logs a disagreement so we can finally learn the real response wire
 *  layout against a live drop (the response is believed to echo the offering BASE time, not our
 *  slot, and a field layout unlike the request). A real lock echoes a "YYYY-MM-DDTHH:MM" (…:SS
 *  optional) datetime and an id; we read the datetime from the printable text and the id from the
 *  field-3 varint encodeTockLock writes (tag 0x18). `bytes` is optional — text-only echoes still
 *  yield the datetime. Returns whatever it could read; absent fields mean "not readable". */
export function parseLockEcho(text: string, bytes?: Uint8Array | number[]): { dateTime?: string; experienceId?: number } {
  const out: { dateTime?: string; experienceId?: number } = {};
  // Datetime: the echoed reservation stamp; keep just the minute precision we lock at.
  const dt = /(\d{4}-\d{2}-\d{2}T\d{2}:\d{2})/.exec(text || '');
  if (dt) out.dateTime = dt[1];
  // Experience id: field 3 varint (tag byte 0x18) — same wire shape encodeTockLock writes.
  if (bytes) {
    const b = Array.from(bytes);
    const i = b.indexOf(0x18);
    if (i >= 0 && i + 1 < b.length) {
      let v = 0, shift = 0, j = i + 1;
      while (j < b.length && (b[j] & 0x80)) { v |= (b[j] & 0x7f) << shift; shift += 7; j++; }
      if (j < b.length) { v |= b[j] << shift; out.experienceId = v >>> 0; }
    }
  }
  return out;
}

/** Classify a `PUT /api/ticket/group/lock` response. The endpoint returns HTTP 200 for BOTH
 *  a real hold and a conflict (the conflict body is a short human-readable error like
 *  "someone else just selected this and it is no longer available" — confirmed live on
 *  n/naka 2026-07-05, ~89 bytes; a real lock is a large protobuf, ~1200+ bytes, echoing the
 *  reservation). Checking only the status/size would treat a conflict as a win and skip the
 *  fallback. `text` is the response body's printable chars.
 *   - 'blocked'  → not even a lock response (HTML interstitial / network error) → fall back
 *   - 'conflict' → 200 but the slot was taken → retry another time / fall back
 *   - 'held'     → a genuine lock
 *  NOTE: the legacy poll/grab path (grabViaApi) keeps using this three-way verdict; the volley
 *  path uses classifyLock (four-way) so it can also keep an ambiguous 'rejected' cell retryable. */
export function lockResponseVerdict(status: number, contentType: string, len: number, text: string): 'held' | 'conflict' | 'blocked' {
  if (status !== 200 || /html/i.test(contentType || '')) return 'blocked';
  // Human-readable failure phrases never appear in a genuine lock (which echoes the
  // restaurant/date/time), so any of these means the hold did not take.
  if (/no longer available|unfortunately|not available|already (taken|selected|booked|reserved|held)|sold\s*out|unable to|cannot be|invalid|expired|error/i.test(text || '')) return 'conflict';
  // A real lock body is substantial; a stray tiny 200 with no error text is still suspect.
  if (len < 150) return 'conflict';
  return 'held';
}

/** Direct-API grab (Cloudflare-proof): hold the slot by PUTting the lock protobuf via an
 *  in-page fetch that reuses the warm session's cf_clearance + captured x-tock-* headers —
 *  NO document navigation, so it never draws the Turnstile that a reload does. On success
 *  the slot is HELD (~10 min), so the checkout navigation afterward is unhurried and a
 *  challenge there is retryable. Returns a retryable GrabResult on any non-200 so the
 *  caller can fall back to the reload+click path (never worse than the old behavior). */
async function grabViaApi(
  page: Page, restaurant: string, date: string, time24: string, partySize: number,
  experienceId: number, seatingAreaId: number | undefined, headers: Record<string, string>,
  prepaidCents = 0, opts: { skipLock?: boolean } = {},
): Promise<GrabResult> {
  // Normalize the time to zero-padded 24h "HH:MM" — the lock datetime must match Tock's format
  // exactly (a stray "9:00" would build a lock the server rejects).
  const tm = /^(\d{1,2}):(\d{2})$/.exec(time24.trim());
  const normTime = tm ? `${tm[1].padStart(2, '0')}:${tm[2]}` : time24.trim();
  const dateTime = `${date}T${normTime}`;
  // skipLock: the VOLLEY already holds this cell in THIS page's server-side cart, so re-issuing the
  // PUT would be redundant and — worse — can return a self-conflict ("someone else just selected
  // this") against our own hold, false-freezing a genuine win. When set, jump straight to checkout
  // navigation and let the confirm-purchase page load the existing hold (§C1 checkout tail).
  if (!opts.skipLock) {
    const bodyB64 = encodeTockLock(partySize, dateTime, experienceId, seatingAreaId, prepaidCents).toString('base64');
    const lock = await page.evaluate(async ({ b64, hdrs }) => {
      const bin = atob(b64); const body = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) body[i] = bin.charCodeAt(i);
      try {
        const r = await fetch('/api/ticket/group/lock', {
          method: 'PUT', credentials: 'include',
          headers: { 'content-type': 'application/octet-stream', ...hdrs, 'x-tock-stream-format': 'proto2' },
          body,
        });
        const buf = new Uint8Array(await r.arrayBuffer());
        // Decode printable text from the protobuf body — a real lock echoes reservation
        // details; a conflict returns a short human-readable error ("no longer available").
        const text = new TextDecoder().decode(buf).replace(/[^\x20-\x7e]/g, ' ');
        return { status: r.status, len: buf.length, contentType: r.headers.get('content-type') || '', text: text.slice(0, 400) };
      } catch (e) { return { status: 0, len: 0, contentType: '', text: '', err: String(e) }; }
    }, { b64: bodyB64, hdrs: headers });

    // Reject anything that isn't a genuine lock so we correctly fall back / retry instead of
    // treating a conflict as a win (the endpoint returns HTTP 200 with an ERROR body — e.g.
    // "no longer available" — for a taken slot; confirmed live on n/naka 2026-07-05).
    const verdict = lockResponseVerdict(lock.status, lock.contentType, lock.len, lock.text);
    if (verdict !== 'held') {
      return { ok: false, reason: `API lock not confirmed (${verdict}: HTTP ${lock.status}, ${lock.len}B${lock.err ? ', ' + lock.err : ''}${lock.text.trim() ? ', "' + lock.text.trim().slice(0, 60) + '"' : ''}) — falling back`, slotTakenAtClick: verdict === 'conflict', failedTime12: to12Hour(time24) };
    }
    console.log(`   🔒 API lock held ${date} ${to12Hour(time24)} (exp ${experienceId}${seatingAreaId != null ? `, seating ${seatingAreaId}` : ''}, ${lock.len}B)`);
  } else {
    console.log(`   🔒 reusing volley-held ${date} ${to12Hour(time24)} — navigating to checkout (no re-lock)`);
  }

  // Slot is held — reach checkout so handlePurchaseFlow can drive add-ons → confirm. The
  // confirm-purchase page loads the current lock when authenticated (redirects only if the
  // session isn't logged in). A challenge here is retryable within the ~10-min hold — the
  // RACE is already won by the lock. Try confirm-purchase, then the /checkout root.
  const wantDate = checkoutDateString(date);
  for (const path of ['/checkout/confirm-purchase', '/checkout']) {
    for (let attempt = 1; attempt <= 2; attempt++) {
      await page.goto(`https://www.exploretock.com/${restaurant}${path}`, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
      await sleep(1200); // let the SPA settle / route
      const state = await page.evaluate(() => ({
        text: ((globalThis as any).document.body?.innerText || '').slice(0, 4000),
        atCheckout: /\/checkout/.test((globalThis as any).location?.pathname || ''),
      })).catch(() => ({ text: '', atCheckout: true }));
      const challenged = /verify you are human|just a moment/i.test(state.text);
      if (!challenged && state.atCheckout) {
        // WRONG-SLOT GUARD: same-price slots make the $ cap blind to a wrong date/time, so
        // confirm the checkout shows the intended date before letting the purchase proceed.
        if (wantDate && !state.text.includes(wantDate)) {
          console.log(`   🛑 checkout shows a DIFFERENT date than ${wantDate} — aborting purchase (held slot frozen for inspection)`);
          return { ok: true, time12: to12Hour(time24), heldNoCheckout: true };
        }
        return { ok: true, time12: to12Hour(time24) };
      }
      if (challenged) { console.log(`   ⏳ checkout challenged (${path} #${attempt}) — held, retrying`); await sleep(2000); }
      else break; // redirected off /checkout — try the next path
    }
  }
  // Held but couldn't reach checkout — hold persists (~10 min). Signal so the caller freezes
  // for manual completion instead of burning the purchase flow on a non-checkout page.
  return { ok: true, time12: to12Hour(time24), heldNoCheckout: true };
}

/** Reload-on-hit DOM grab: the poller detected a slot via fetch, but the DOM still
 *  shows stale state, so reload once (slot now renders) and click the ENABLED Book
 *  button whose time matches. Fails fast instead of hammering a disabled button.
 *  Returns a discriminated reason so the caller can distinguish a genuine lost race
 *  from a stale-session/page error. */
async function grabViaDom(page: Page, date: string, time24: string, winStart24?: string, winEnd24?: string, excludeTimes12: string[] = []): Promise<GrabResult> {
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

  // Collect every ENABLED button with its card time (disabled = sold; skipping them is
  // the hang fix). Buttons with no time within nearestTimeText's walk-up range are
  // excluded (typically experience-level "Book now" — though one can inherit a broad
  // container's time; the in-window filter and checkout cap bound the damage).
  const want = to12Hour(time24).toLowerCase();
  const buttons = await page.$$('[data-testid="booking-card-button"], [data-testid^="offering-book-button"]');
  const exclude = new Set(excludeTimes12.map(t => t.toLowerCase()));
  const candidates: { btn: (typeof buttons)[number]; time12: string }[] = [];
  try {
    for (const btn of buttons) {
      if (!(await btn.isEnabled().catch(() => false))) continue;
      const timeText = await btn.evaluate(nearestTimeText);
      // excludeTimes12 = times that already failed a click race this run; don't re-click them.
      if (timeText && !exclude.has(timeText.toLowerCase())) candidates.push({ btn, time12: timeText });
    }
  } catch (err) {
    // Keep a mid-scan page death on the labeled, screenshotted grab-fail path instead of
    // bubbling a bare Playwright error out of the whole run.
    return { ok: false, reason: `candidate scan failed: ${errMsg(err)}` };
  }

  let pick = candidates.find(c => c.time12.toLowerCase() === want);
  if (!pick) {
    // The detected time vanished in the detect→reload gap (sold, or a cross-product
    // false positive). Grab the closest surviving in-window time on THIS date instead
    // of losing the run — the checkout-side price cap still guards the total.
    const fb = pickFallbackTime12(candidates.map(c => c.time12), time24, winStart24, winEnd24);
    pick = fb != null ? candidates.find(c => c.time12 === fb) : undefined;
    if (pick) console.log(`   ⚠️ ${to12Hour(time24)} gone at grab — falling back to ${pick.time12}`);
  }
  if (!pick) {
    // Include the raw button count: "N buttons, enabled times [none]" reads as a dead or
    // odd page; a real lost race shows buttons with out-of-window/sold times.
    return { ok: false, reason: `no enabled in-window slot at grab (lost the race) — ${buttons.length} buttons, enabled times seen [${[...new Set(candidates.map(c => c.time12))].join(', ') || 'none'}]` };
  }

  await pick.btn.scrollIntoViewIfNeeded().catch(() => {});
  try { await pick.btn.click({ timeout: 5000 }); }
  catch { return { ok: false, reason: 'matched slot button click failed' }; }
  const seat = await clickSeatingAreaForTime(page, pick.time12);
  if (!seat.ok) return seat;

  // The click can land on a stale-enabled button (owner-observed: "this time slot is no
  // longer available", no navigation). Verify the hold started; a lost race is retryable.
  const hold = await verifyHoldStarted(page);
  if (hold === 'taken') {
    console.log(`   🔁 ${pick.time12} was taken at click ("no longer available") — retrying with it excluded`);
    return { ok: false, reason: `slot taken at click: ${pick.time12} no longer available`, slotTakenAtClick: true, failedTime12: pick.time12 };
  }
  return { ok: true, time12: pick.time12 };
}

// ===========================================================================================
// T0 VOLLEY FIRE ENGINE (§1,§3,§4,§6) — pre-fired authenticated lock volley for sub-second drops
// ===========================================================================================

/** The resolved outcome of one page's fire loop. `held` is the ONLY success; every other field
 *  is diagnostic. `echoedCell` is what the winning lock echoed (for the attribution guard), and
 *  `diag` is a short human-readable trail (verdict tally, fire count) surfaced in SniperResult. */
export interface VolleyResult {
  held: boolean;
  date?: string;
  time24?: string;
  experienceId?: number;
  f6?: number;
  bodyLen?: number;
  echoedCell?: { dateTime?: string; experienceId?: number; mismatch?: boolean };
  diag?: string;
}

/** A cross-page ignition signal. The volley loops `await` the same promise so ONE resolve()
 *  (from watchPopulateEdge's populate edge OR the computed fire clock, whichever comes first)
 *  ignites every page's burst at once — no per-page CDP hop at the drop instant. `fire()` is
 *  idempotent (first caller wins); `armed` lets a late watcher skip a redundant resolve. */
export class Ignition {
  private resolve!: () => void;
  private fired = false;
  readonly ready: Promise<void>;
  constructor() { this.ready = new Promise<void>(r => { this.resolve = r; }); }
  fire(): void { if (!this.fired) { this.fired = true; this.resolve(); } }
  get armed(): boolean { return this.fired; }
}

/** Fire ONE page's pre-encoded lock volley (§1.1, §4.1, Task 4). This is the hot path: a single
 *  long-lived page.evaluate — injected at arm time (~T−2s) so the CDP hop is paid ONCE, not per
 *  PUT — that (a) awaits ignition via a polled window flag, (b) busy-spins the final few ms on
 *  performance.now(), (c) fires the wanted cells as a bounded-concurrency (≤maxInFlight) in-page
 *  fetch('/api/ticket/group/lock', PUT, credentials:'include') burst, (d) classifies each reply
 *  INLINE (ported classifyLock, fail-open: conflict prunes; any large non-conflict 200 wins;
 *  rejected/blocked keep the cell live), (e) re-fires only NON-held, non-conflict cells every
 *  reFireMs until a HELD, a cross-page STOP, or the deadline, with an at-most-one-in-flight-PER-CELL
 *  guard, and (f) resolves the winning cell + its (diagnostic-only) echo.
 *
 *  The busy-spin AND the fetch run in the SAME renderer that owns cf_clearance — no CDP round-trip
 *  in the hot path (§1.1). The ignition is delivered as a window flag the caller flips via
 *  page.evaluate at the drop edge; the loop polls it on a tight rAF-free `setTimeout(0)` cadence so
 *  it reacts within a frame. Bounded aggregate rate (≤maxInFlight in flight, reFireMs between waves)
 *  is the anti-WAF lever (§5): 1–3 cells × ≤5 in flight × reFireMs stays far below a blind fusillade.
 *
 *  @param page         a warmed page (past Cloudflare, carrying cf_clearance + login cookies)
 *  @param candidates   this page's DISJOINT cell partition (best-first) — no cell fired by two pages
 *  @param headers      the frozen x-tock-* set (from readTockHeadersFromPage / capture)
 *  @param ignition     shared cross-page ignition; the loop is armed early and awaits its flag
 *  @param opts         reFireMs (re-fire cadence), deadlineMs (sustain window), maxInFlight (≤5) */
async function fireVolley(
  page: Page,
  candidates: LockCandidate[],
  headers: Record<string, string>,
  ignition: Ignition,
  stop: Ignition,
  opts: { reFireMs: number; deadlineMs: number; maxInFlight?: number },
): Promise<VolleyResult> {
  const maxInFlight = Math.max(1, Math.min(opts.maxInFlight ?? 5, 5));
  // A per-page window flag is the ignition channel: the caller flips it via page.evaluate at the
  // edge; the in-page loop polls it. Using a flag (vs exposeFunction) keeps the whole hot path in
  // one renderer with no CDP callback, and survives the caller resolving from either trigger.
  // STOP_FLAG is the cross-page halt (§I3): the caller flips it once ANY page holds so the losing
  // pages abandon their loops (no stranded holds, no post-win anti-WAF traffic).
  const IGNITE_FLAG = '__tockVolleyIgnite';
  const STOP_FLAG = '__tockVolleyStop';
  try { await page.evaluate((fs) => { for (const f of fs) (globalThis as any)[f] = false; }, [IGNITE_FLAG, STOP_FLAG]); } catch { /* page may be dying; the evaluate below will surface it */ }

  // Fire-and-arm the long-lived renderer loop. It self-contains classifyLock's logic (no outer
  // refs cross into evaluate) so the entire fire + classify + re-fire loop lives in-page.
  const runInPage = page.evaluate(async (args) => {
    const { cells, hdrs, igniteFlag, stopFlag, reFireMs, deadlineMs, maxInFlight } = args as {
      cells: Array<{ key: string; date: string; time24: string; experienceId: number; f6: number; b64: string; primary: boolean }>;
      hdrs: Record<string, string>; igniteFlag: string; stopFlag: string; reFireMs: number; deadlineMs: number; maxInFlight: number;
    };
    const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));
    const b64ToBytes = (b64: string) => { const bin = atob(b64); const u = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i); return u; };

    // Inline verdict classifier — FAIL-OPEN on wins: any large (≥150B) 200 body that is NOT the
    // confirmed conflict shape is a real lock → 'held'. The echo (parsed below) is DIAGNOSTIC ONLY;
    // it must never downgrade a win, because the lock RESPONSE is a different protobuf message than
    // the REQUEST — it echoes the offering's base time (not our slot) and its field layout differs,
    // so an echo "mismatch" is usually a parse artifact, not a wrong slot. Blocking a win on it
    // silently loses a slot we actually hold (§C1). The checkout-side date guard + price cap are the
    // real attribution/spend backstops; every candidate we fire is already a WANTED cell.
    const CONFLICT_RE = /no longer available|already (taken|selected|booked|reserved|held)|sold\s*out/i;
    const classify = (status: number, ct: string, len: number, text: string) => {
      if (status !== 200 || /html/i.test(ct || '')) return 'blocked';
      if (CONFLICT_RE.test(text || '')) return 'conflict';
      if (len >= 150) return 'held';
      return 'rejected';
    };
    // Inline echo parse (datetime from printable text; experienceId from the field-3 varint, tag 0x18).
    const parseEcho = (text: string, bytes: Uint8Array): { dateTime?: string; experienceId?: number } => {
      const o: { dateTime?: string; experienceId?: number } = {};
      const m = /(\d{4}-\d{2}-\d{2}T\d{2}:\d{2})/.exec(text || '');
      if (m) o.dateTime = m[1];
      const i = bytes.indexOf(0x18);
      if (i >= 0 && i + 1 < bytes.length) { let v = 0, s = 0, j = i + 1; while (j < bytes.length && (bytes[j] & 0x80)) { v |= (bytes[j] & 0x7f) << s; s += 7; j++; } if (j < bytes.length) { v |= bytes[j] << s; o.experienceId = v >>> 0; } }
      return o;
    };

    // Await ignition, then busy-spin the final <5ms on performance.now() so the first PUT leaves
    // the wire as close to the edge as the renderer allows (no setTimeout jitter on the last ms).
    while (!(globalThis as any)[igniteFlag]) await sleep(0);
    const spinStart = performance.now();
    while (performance.now() - spinStart < 3) { /* tight spin: last few ms, in-renderer */ }

    // Per-cell state: pruned (confirmed conflict), inFlight (the one-per-cell guard), and a running
    // verdict tally for diagnostics. Live cells are everything not pruned.
    const pruned = new Set<string>();
    const inFlight = new Set<string>();
    const tally: Record<string, number> = { held: 0, 'held-mismatch': 0, conflict: 0, rejected: 0, blocked: 0, error: 0 };
    type Won = { date: string; time24: string; experienceId: number; f6: number; bodyLen: number; echoDt?: string; echoId?: number; echoMismatch?: boolean };
    const winbox: { v: Won | null } = { v: null }; // boxed so the async closure's mutation isn't narrowed away
    let fires = 0;

    // Fire one cell (guarded to at-most-one-in-flight). Resolves after classifying its reply.
    const fireCell = async (c: typeof cells[number]) => {
      if (winbox.v || (globalThis as any)[stopFlag] || pruned.has(c.key) || inFlight.has(c.key)) return;
      inFlight.add(c.key); fires++;
      const intendedDt = `${c.date}T${c.time24}`;
      try {
        const r = await fetch('/api/ticket/group/lock', {
          method: 'PUT', credentials: 'include',
          headers: { 'content-type': 'application/octet-stream', ...hdrs, 'x-tock-stream-format': 'proto2' },
          body: b64ToBytes(c.b64),
        });
        const buf = new Uint8Array(await r.arrayBuffer());
        const text = new TextDecoder().decode(buf).replace(/[^\x20-\x7e]/g, ' ').slice(0, 400);
        const echo = parseEcho(text, buf);
        const v = classify(r.status, r.headers.get('content-type') || '', buf.length, text);
        tally[v] = (tally[v] || 0) + 1;
        if (v === 'held' && !winbox.v) {
          // DIAGNOSTIC ONLY: record whether the echo looked like a different cell (never blocks the
          // win — see classify). This surfaces the real wire layout the first time we see a live drop.
          const echoMismatch = (echo.dateTime != null && echo.dateTime !== intendedDt) ||
                               (echo.experienceId != null && echo.experienceId !== c.experienceId);
          if (echoMismatch) tally['held-mismatch']++;
          winbox.v = { date: c.date, time24: c.time24, experienceId: c.experienceId, f6: c.f6, bodyLen: buf.length, echoDt: echo.dateTime, echoId: echo.experienceId, echoMismatch };
        } else if (v === 'conflict') pruned.add(c.key); // the ONLY pruning verdict (fail-open, §3.3.4)
        // rejected / blocked: keep the cell live and re-fire.
      } catch { tally.error++; /* network throw: keep the cell live and retry next wave */ }
      finally { inFlight.delete(c.key); }
    };

    // Sustain loop: fire live cells in best-first order, ≤maxInFlight concurrent, re-firing every
    // reFireMs until a HELD or the deadline. Best-first + the in-flight cap keeps the aggregate
    // bounded (anti-WAF) while still blanketing the drop window.
    const deadline = performance.now() + deadlineMs;
    while (!winbox.v && !(globalThis as any)[stopFlag] && performance.now() < deadline) {
      let launched = 0;
      for (const c of cells) {
        if (winbox.v || (globalThis as any)[stopFlag]) break;
        if (pruned.has(c.key) || inFlight.has(c.key)) continue;
        if (inFlight.size >= maxInFlight) break;
        void fireCell(c);
        launched++;
      }
      // If every live cell is already in flight (or all pruned), just wait a wave; else pace at reFireMs.
      await sleep(reFireMs);
      if (launched === 0 && pruned.size >= cells.length) break; // all cells confirmed-conflict → nothing left to try
    }
    const stopped = !winbox.v && (globalThis as any)[stopFlag] ? ' stopped' : '';
    const diag = `fires=${fires} held=${tally.held} mism=${tally['held-mismatch']} conf=${tally.conflict} rej=${tally.rejected} blk=${tally.blocked} err=${tally.error}${stopped}`;
    const won = winbox.v;
    if (won) return { held: true, date: won.date, time24: won.time24, experienceId: won.experienceId, f6: won.f6, bodyLen: won.bodyLen, echoedCell: { dateTime: won.echoDt, experienceId: won.echoId, mismatch: won.echoMismatch }, diag };
    return { held: false, diag };
  }, {
    cells: candidates.map(c => ({ key: c.key, date: c.date, time24: c.time24, experienceId: c.experienceId, f6: c.f6, b64: c.b64, primary: c.primary })),
    hdrs: headers, igniteFlag: IGNITE_FLAG, stopFlag: STOP_FLAG, reFireMs: opts.reFireMs, deadlineMs: opts.deadlineMs, maxInFlight,
  }).catch((err): VolleyResult => ({ held: false, diag: `evaluate threw: ${errMsg(err)}` }));

  // Bridge the shared Ignition into this page's window flag the instant ignition fires. The
  // renderer loop is already armed and spinning on the flag; flipping it releases the busy-spin.
  ignition.ready.then(() => page.evaluate((f) => { (globalThis as any)[f] = true; }, IGNITE_FLAG).catch(() => { /* page dead → its loop resolves not-held */ }));

  // Bridge the shared STOP into this page's halt flag: once any page holds (caller fires stop), this
  // page's loop sees the flag and abandons its remaining cells rather than firing to the deadline.
  stop.ready.then(() => page.evaluate((f) => { (globalThis as any)[f] = true; }, STOP_FLAG).catch(() => { /* page dead → its loop already resolved */ }));

  return runInPage as Promise<VolleyResult>;
}

/** REACT-TO-POPULATE detector (§2.1 Layer B, Task 6): from ~T0−2s, low-rate poll fetchOfferingsFast
 *  on the target week and resolve the INSTANT the grid populates (any bookable slot for the party
 *  size on a wanted date appears). The observed populate edge is the server-authoritative T0 —
 *  more accurate than any Date-header math and immune to the late-release problem (§0.3) — so it
 *  drives ignition. Resolves { populated:true, offerings } on the edge, or { populated:false } at
 *  deadline. Low rate (~150–250ms) by design: we react, we don't hammer pre-drop (§5.3). */
async function watchPopulateEdge(
  page: Page,
  req: BookingRequest,
  deadlineMs: number,
  pollMs = 200,
): Promise<{ populated: boolean; offerings?: any }> {
  const wantedDates = new Set(req.dates);
  const deadline = Date.now() + deadlineMs;
  while (Date.now() < deadline) {
    const offerings = await fetchOfferingsFast(page, searchUrlFor(req, req.dates[0]));
    if (offerings && !offerings.__challenge && !offerings.__noState) {
      const slots = parseAvailability(offerings, req.partySize);
      // The edge = any bookable slot on a wanted date. (A slot on a non-wanted date means the
      // venue's calendar populated but not our target week — keep watching.)
      if (slots.some(s => wantedDates.has(s.date))) return { populated: true, offerings };
    }
    await sleep(pollMs);
  }
  return { populated: false };
}

/** Live experience/price/openTime read for the CURRENTLY-bookable week, ~T−3s (§3.3.1, Task 3).
 *  Next week's grid is EMPTY until the drop, so we read the current live week and assume menu
 *  continuity into next week, reconciling against the known FHH constants. Returns the values the
 *  volley should build bodies against: the live experienceId/prepaidCents/openTime when readable,
 *  else the config fallback (fixedExperienceId/fixedPrepaidCents) or the FHH constants. `drifted`
 *  flags when the live current-week values differ from the known constants — the caller alerts
 *  loudly (§3.3.1) before firing hardcoded bodies. */
async function preDropRecon(
  page: Page,
  req: BookingRequest,
  cfg: SniperConfig,
): Promise<{ experienceId: number; prepaidCents: number; seatingAreaId?: number; openTime?: string[]; drifted: boolean; source: 'live' | 'fallback' }> {
  const FHH_EXPERIENCE_ID = 559289;
  const FHH_PREPAID_CENTS = 25800;
  const fallbackExp = cfg.fixedExperienceId ?? FHH_EXPERIENCE_ID;
  const fallbackF6 = cfg.fixedPrepaidCents ?? FHH_PREPAID_CENTS;

  const offerings = await fetchOfferingsFast(page, searchUrlFor(req, req.dates[0]));
  if (!offerings || offerings.__challenge || offerings.__noState) {
    return { experienceId: fallbackExp, prepaidCents: fallbackF6, drifted: false, source: 'fallback' };
  }
  const o = offerings as TockOfferings;
  const bookable = (Array.isArray(o.experience) ? o.experience : [])
    .filter(e => e?.state === 'AVAILABLE' && Array.isArray(e?.partySize) && e.partySize!.includes(req.partySize));
  if (!bookable.length) {
    // Empty/SOLD current week (the common FHH pre-drop state) → trust the fallback constants.
    return { experienceId: fallbackExp, prepaidCents: fallbackF6, openTime: Array.isArray(o.openTime) ? o.openTime : undefined, drifted: false, source: 'fallback' };
  }
  const liveExp = Number(bookable[0].id);
  const liveF6 = experiencePriceCents(bookable[0]) ?? fallbackF6;
  const experienceId = Number.isFinite(liveExp) ? liveExp : fallbackExp;
  const prepaidCents = liveF6;
  // First seating-area id (f13), read the SAME way normalizeSlots does — a multi-seating venue
  // (JouJou) requires it in the lock, and the volley's preDropRecon is the only live read before
  // buildCandidateBodies. Absent/[] for direct-book venues (FHH) → undefined → no f13. cfg.
  // fixedSeatingAreaId stays an explicit override for when the live read can't see it.
  const rawSeat = bookable[0].seatingArea?.[0];
  const rawSeatId = rawSeat == null ? undefined : Number(typeof rawSeat === 'object' ? (rawSeat as { id?: number | string }).id : rawSeat);
  const seatingAreaId = Number.isFinite(rawSeatId as number) ? (rawSeatId as number) : undefined;
  // Drift = the live current-week experience/price differs from the known-good constants. The
  // menu is assumed continuous into next week, so a mismatch here is the pre-drop alarm (§3.3.1).
  const drifted = experienceId !== fallbackExp || prepaidCents !== fallbackF6;
  return { experienceId, prepaidCents, seatingAreaId, openTime: Array.isArray(o.openTime) ? o.openTime : undefined, drifted, source: 'live' };
}

/** Split the best-first candidate list into `n` DISJOINT partitions (§5.2 "partition, don't pile"):
 *  round-robin so each page owns a distinct subset (no cell fired by two pages) and the highest-
 *  priority cells are spread across pages rather than all landing on page 0. Empty partitions are
 *  dropped so a large pool with few cells doesn't arm idle loops. PURE (unit-testable). */
export function partitionCandidates(candidates: LockCandidate[], n: number): LockCandidate[][] {
  const parts: LockCandidate[][] = Array.from({ length: Math.max(1, n) }, () => []);
  candidates.forEach((c, i) => parts[i % parts.length].push(c));
  return parts.filter(p => p.length > 0);
}

/** PURE. Resolve the wanted (dates × times) the volley builds bodies for, from cfg + req: prefer
 *  the operator's explicit wantedDates/wantedTimes24, else fall back to req.dates / [req.time],
 *  and clamp the times to the accept window (§4.1 "in-window times, best-time-first"). Kept pure
 *  so the cell selection is unit-testable independent of the browser plumbing. */
export function resolveWantedCells(req: BookingRequest, cfg: SniperConfig): { wantedDates: string[]; wantedTimes24: string[] } {
  const wantedDates = (cfg.wantedDates?.length ? cfg.wantedDates : req.dates).slice();
  const rawTimes = cfg.wantedTimes24?.length ? cfg.wantedTimes24 : [req.time];
  const lo = cfg.timeWindowStart24 ? timeToMin(cfg.timeWindowStart24) : -Infinity;
  const hi = cfg.timeWindowEnd24 ? timeToMin(cfg.timeWindowEnd24) : Infinity;
  const wantedTimes24 = rawTimes.filter(t => { const m = timeToMin(t); return m >= lo && m <= hi; });
  // If the window excluded every requested time (misconfig), fall back to the raw times rather
  // than arming an empty volley — the checkout-side cap still guards the actual spend.
  return { wantedDates, wantedTimes24: wantedTimes24.length ? wantedTimes24 : rawTimes };
}

/** Options threaded from runSniper into the volley sub-engine — the shared clock base, the
 *  normalized cap, and a hook to hand a winning browser to a frozen session (so runSniper's
 *  finally block spares it from close). */
interface VolleyModeOpts {
  base: number;                 // epoch ms of runAt (or now) — the coarse drop anchor
  runAt?: string;               // the scheduled drop instant (ISO), if any → t0Epoch/clock lead
  startTime: number;            // runSniper's start, for durationMs
  maxPriceCents?: number;       // normalized fail-closed cap
  setFrozen: (b: Browser) => void; // register the handed-off browser so finally doesn't close it
}

/**
 * T0 Volley Fire sub-engine (§1,§3,§4, Task 7). Called by runSniper when cfg.volleyFire is set,
 * with an already-warmed pool. Sequence:
 *   1. calibrateClock on the freshest page (hard-gate confidence; fall back gracefully to the
 *      react-to-populate edge alone if the clock is untrustworthy).
 *   2. preDropRecon (T−3s): read live experienceId/prepaidCents; alert on drift vs FHH constants.
 *   3. Freeze the x-tock-* headers (readTockHeadersFromPage; HARD-GATE non-null — never fire
 *      authless locks that all 401 and burn the window silently).
 *   4. buildCandidateBodies for the wanted cells → partition disjointly across warm pages (§5.2).
 *   5. Arm fireVolley on every page (awaiting a shared Ignition) + watchPopulateEdge.
 *   6. Ignite off min(computed fireAt from the clock, observed populate edge) under SingleWinnerLock.
 *   7. First HELD wins → ATTRIBUTION GUARD (echoed date/experience must match intent) → reuse the
 *      existing grabViaApi checkout tail / handlePurchaseFlow(maxPriceCents) → freeze fallback
 *      (with the cap) + notifyHeld.
 * Preserves SniperResult shape; surfaces volley diagnostics in the error/result.
 */

/** The coarse drop-anchor epoch (ms) for the volley's fallback/watch schedule. Uses t0Epoch — the
 *  same DST-correct America/Los_Angeles parse the clock's computedFireAt uses — so `base` and the
 *  clock schedule share ONE timebase (§I2). `new Date(runAt)` was wrong for a BARE wall-time runAt:
 *  it reads it in the server's zone (UTC on Railway), landing the fallback hours off. Falls back to
 *  Date.now() when there's no runAt or it's unparseable (validateSniperConfig gates real configs). */
function dropAnchorEpoch(runAt?: string): number {
  if (!runAt) return Date.now();
  try { return t0Epoch(runAt); } catch { return Date.now(); }
}

async function runVolleyMode(
  req: BookingRequest,
  cfg: SniperConfig,
  live: Warm[],
  opts: VolleyModeOpts,
): Promise<SniperResult> {
  const { base, runAt, startTime, maxPriceCents, setFrozen } = opts;
  const durationMs = () => Date.now() - startTime;
  const noPolls = { total: 0, matched: 0 };
  const reFireMs = cfg.reFireMs ?? 60;
  const deadlineMs = cfg.volleyDeadlineMs ?? 30_000;
  const fireLeadMs = cfg.fireLeadMs ?? 0;

  console.log(`\n🔫 VOLLEY MODE: pages=${live.length}, reFire=${reFireMs}ms, deadline=${deadlineMs}ms, lead=${fireLeadMs}ms`);

  // --- 1. Clock calibration (Layer A, coarse window). Hard-gate confidence per §2.1: if the clock
  // is untrustworthy we do NOT predict T0 from it — we lean entirely on the react-to-populate edge
  // (which is authoritative anyway). A bad clock degrades gracefully, it doesn't abort the drop. ---
  let computedFireAt: number | undefined;
  let clockDiag = 'clock: skipped (no runAt)';
  if (runAt) {
    try {
      const cal = await calibrateClock(live[0].page);
      const edgeEpoch = t0Epoch(runAt);         // DST-correct drop instant (America/Los_Angeles)
      const CONFIDENCE_GATE_MS = 500;           // §2.1: refuse to predict on worse than ±500ms
      if (cal.confidenceMs <= CONFIDENCE_GATE_MS) {
        // Correct the local wall clock by the measured offset, then fire lead ms early so the
        // packet ARRIVES at the origin at the open instant (computeFireAt clamps lead to RTT).
        computedFireAt = computeFireAt(edgeEpoch - cal.offsetMs, cal.minRttMs, fireLeadMs);
        clockDiag = `clock: offset=${cal.offsetMs}ms conf=±${cal.confidenceMs}ms rtt=${cal.minRttMs}ms fireAt=+${computedFireAt - Date.now()}ms`;
      } else {
        clockDiag = `clock: LOW-CONFIDENCE ±${cal.confidenceMs}ms > ${CONFIDENCE_GATE_MS}ms — react-to-populate only`;
        console.warn(`   ⚠️ ${clockDiag}`);
      }
    } catch (err) {
      clockDiag = `clock: calibrate failed (${errMsg(err)}) — react-to-populate only`;
      console.warn(`   ⚠️ ${clockDiag}`);
    }
  }
  console.log(`   ${clockDiag}`);

  // --- 2. Pre-drop reconcile (T−3s): live experienceId/prepaidCents, drift alarm vs constants. ---
  const recon = await preDropRecon(live[0].page, req, cfg);
  if (recon.drifted) {
    console.warn(`   🚨 PRICE/EXPERIENCE DRIFT: live current-week exp=${recon.experienceId} f6=${recon.prepaidCents} differs from constants (${cfg.fixedExperienceId ?? 559289}/${cfg.fixedPrepaidCents ?? 25800}) — firing reconciled values`);
  }
  console.log(`   recon: exp=${recon.experienceId} f6=${recon.prepaidCents}${recon.seatingAreaId != null ? ` seat=${recon.seatingAreaId}` : ''} (${recon.source})`);

  // --- 3. Freeze headers (HARD-GATE non-null, §3.2). Prefer the header set already captured/
  // reconstructed during warm-up; re-read once as a freshness check. If NO page yields headers,
  // abort loudly — every authless lock would 401 and silently burn the window. ---
  let headers: Record<string, string> | undefined;
  let headerPage: Warm | undefined;
  for (const w of live) {
    const h = w.tockHeaders ?? (await readTockHeadersFromPage(w.page).catch(() => null)) ?? undefined;
    if (h) { headers = h; headerPage = w; if (!w.tockHeaders) { w.tockHeaders = h; w.headerSource = 'page-grab'; } break; }
  }
  if (!headers) {
    return { success: false, error: `Volley aborted: x-tock-* headers unreconstructable on every warm page — refusing to fire authless locks (${clockDiag})`, durationMs: durationMs(), polls: noPolls };
  }
  console.log(`   headers frozen (src=${headerPage?.headerSource ?? 'unknown'})`);

  // --- 4. Build the candidate bodies for the wanted cells, then partition disjointly across pages. ---
  const { wantedDates, wantedTimes24 } = resolveWantedCells(req, cfg);
  const candidates = buildCandidateBodies(req, {
    experienceId: recon.experienceId,
    prepaidCents: recon.prepaidCents,
    wantedDates,
    wantedTimes24,
    // FHH is direct-book ([] seatingArea) so no f13; a multi-seating venue (JouJou) gets its seating
    // id from the live recon, with cfg.fixedSeatingAreaId as an explicit override/fallback.
    seatingAreaId: recon.seatingAreaId ?? cfg.fixedSeatingAreaId,
    f6Candidates: cfg.f6Candidates,
  });
  if (!candidates.length) {
    return { success: false, error: `Volley aborted: no candidate cells (dates=[${wantedDates.join(',')}] times=[${wantedTimes24.join(',')}])`, durationMs: durationMs(), polls: noPolls };
  }
  const partitions = partitionCandidates(candidates, live.length);
  console.log(`   ${candidates.length} candidate cells over ${partitions.length} pages (best-first, disjoint)`);

  // --- 5. Arm fireVolley on every partitioned page (awaiting a shared Ignition) + watchPopulateEdge. ---
  const ignition = new Ignition();
  const stopAll = new Ignition();     // cross-page halt: fired the instant ANY page holds (§I3)
  const claim = new SingleWinnerLock();
  const armed = live.slice(0, partitions.length);
  const volleys = armed.map((w, i) => fireVolley(w.page, partitions[i], headers!, ignition, stopAll, { reFireMs, deadlineMs, maxInFlight: 5 }));
  // The instant any page resolves HELD, halt the others so they abandon their partitions rather than
  // firing to the deadline (no stranded holds on the shared account, no post-win anti-WAF traffic).
  volleys.forEach(p => p.then(v => { if (v?.held) stopAll.fire(); }).catch(() => { /* a rejected volley can't be the winner */ }));

  // --- 6. Ignite off min(computed fireAt, populate edge). Firing a hair early is free (early PUTs
  // conflict/not-yet-open and simply retry); firing late loses (§2.1). We start the populate watch
  // now and, in parallel, schedule the clock-computed fire; whichever fires first wins the race. ---
  const watchDeadlineMs = computedFireAt != null ? Math.max(0, computedFireAt - Date.now()) + deadlineMs + 3000 : deadlineMs + 3000;
  const populateWatch = watchPopulateEdge(live[0].page, req, watchDeadlineMs).then((edge) => {
    if (edge.populated && !ignition.armed) { console.log('   🟢 populate edge observed — igniting'); ignition.fire(); }
    return edge;
  });
  if (computedFireAt != null) {
    const wait = computedFireAt - Date.now();
    if (wait > 0) await sleep(wait);
    if (!ignition.armed) { console.log(`   ⏱️ computed fireAt reached — igniting`); ignition.fire(); }
  }
  // If no clock fire scheduled, the populate watch is the sole trigger; also arm a hard fallback so
  // a venue that populates without our detector seeing it (or a missed edge) still fires by base+lead.
  if (!ignition.armed) {
    const fallbackWait = Math.max(0, (base) - Date.now());
    if (fallbackWait > 0) await Promise.race([populateWatch, sleep(fallbackWait)]);
    if (!ignition.armed) { console.log('   ⏱️ fallback ignition (base time reached)'); ignition.fire(); }
  }

  // --- 7. Settle every page volley and pick the winner. A winning page resolves HELD promptly (its
  // in-page loop exits on winbox); that same resolution fires stopAll (armed above), so the losing
  // pages halt and settle quickly rather than running to the deadline. ---
  const results = await Promise.allSettled(volleys);
  const won = results
    .map((r, i) => ({ r, w: armed[i] }))
    .find(({ r }) => r.status === 'fulfilled' && (r.value as VolleyResult).held);
  const diagTrail = results.map((r, i) => `p${i}:${r.status === 'fulfilled' ? (r.value as VolleyResult).diag : 'rej'}`).join(' | ');

  if (!won || won.r.status !== 'fulfilled') {
    console.log(`\n❌ Volley: no HELD across ${armed.length} pages`);
    return { success: false, error: `Volley fired but no HELD — ${clockDiag} · recon exp=${recon.experienceId} f6=${recon.prepaidCents}${recon.drifted ? ' (DRIFTED)' : ''} · ${diagTrail}`, durationMs: durationMs(), polls: noPolls };
  }
  const winResult = won.r.value as VolleyResult;
  const winner = won.w;
  const bookedDate = winResult.date!;
  const bookedTime24 = winResult.time24!;
  const bookedTime = to12Hour(bookedTime24);
  console.log(`\n🔒 VOLLEY HELD: ${bookedDate} ${bookedTime} (exp ${winResult.experienceId}, f6 ${winResult.f6}, ${winResult.bodyLen}B) — ${winResult.diag}`);

  // Claim gate: exactly one winner drives checkout even if two pages held (defense in depth — the
  // per-cell partition already prevents two pages firing the same cell, §4.1).
  if (!claim.tryAcquire()) {
    return { success: false, error: `Volley HELD but claim already taken (concurrent winner) — ${diagTrail}`, durationMs: durationMs(), polls: noPolls };
  }

  // --- ATTRIBUTION (§4.2): the echo is DIAGNOSTIC ONLY — it must NEVER abort a held slot, because a
  // held slot un-driven is a silent loss of a slot we actually hold (§C1). The lock RESPONSE echoes
  // the offering's base time (not our slot) and uses a different field layout than the request, so an
  // echo disagreement is usually a parse artifact. Every candidate we fired is a WANTED cell, and the
  // grabViaApi checkout tail re-asserts the DATE on the live confirm page (freezing for manual review
  // if it's wrong) before any spend. So here we only LOG a disagreement to surface the wire layout. ---
  const intendedDt = `${bookedDate}T${bookedTime24}`;
  const echoDt = winResult.echoedCell?.dateTime;
  const echoId = winResult.echoedCell?.experienceId;
  if (winResult.echoedCell?.mismatch) {
    console.warn(`   ⚠️ echo disagreed with intent (echoed ${echoDt ?? '?'}/${echoId ?? '?'} vs intended ${intendedDt}/${winResult.experienceId}) — proceeding; checkout date guard + cap are the backstop`);
  }

  // A speculative f6-fan win carries a guessed price → surface it so the frozen-session banner
  // flags "GUESSED PRICE" (§4.4). The primary price is the reconciled/known one.
  const guessedPriceCents = winResult.f6 !== recon.prepaidCents ? winResult.f6 : undefined;

  // --- Fire the HELD notification immediately (§4.5 Tier 3): a human may need to finish the modal
  // checkout inside the ~10-min hold, so alert BEFORE the (possibly-failing) auto-checkout attempt. ---
  await notifyHeld(req.restaurant, bookedDate, bookedTime).catch(() => { /* notify never blocks the claim */ });

  const dryRun = cfg.dryRun ?? false;
  const screenshots: string[] = [];

  // --- Reuse grabViaApi's checkout-navigation tail with skipLock: the slot is already HELD in this
  // page's server-side cart, so we navigate straight to confirm-purchase (NO re-lock — a second PUT
  // could self-conflict against our own hold) and let its wrong-slot date guard re-assert the date.
  // On a modal venue this may return heldNoCheckout → freeze-for-manual. ---
  const grab = await grabViaApi(
    winner.page, req.restaurant, bookedDate, bookedTime24, req.partySize,
    winResult.experienceId!, recon.seatingAreaId ?? cfg.fixedSeatingAreaId, headers, winResult.f6 ?? 0,
    { skipLock: true }, // the volley already holds this cell in winner.page's cart — don't re-lock (§C1)
  ).catch((err): GrabResult => ({ ok: false, reason: `checkout tail threw: ${errMsg(err)}` }));

  // Held-but-no-checkout (modal redirect / persistent challenge / wrong-date guard): freeze the
  // winning live browser so a human completes it under the cap within the hold window.
  if (!grab.ok || (grab.ok && grab.heldNoCheckout)) {
    const shot = await safeShot(winner.page); if (shot) screenshots.push(shot);
    const reason = grab.ok
      ? `Volley HELD ${bookedDate} ${bookedTime} but checkout not auto-reached — open the frozen session and complete manually (verify the date + price)`
      : `Volley HELD ${bookedDate} ${bookedTime} but checkout tail failed (${(grab as { reason?: string }).reason}) — frozen for manual completion`;
    if (dryRun) {
      return { success: false, bookedDate, bookedTime, dryRun: true, error: `Dry run: ${reason}`, screenshots, durationMs: durationMs(), polls: noPolls };
    }
    setFrozen(winner.browser);
    const pausedSessionId = freezeSession({ handle: { browser: winner.browser, page: winner.page }, restaurant: req.restaurant, bookedDate, bookedTime, error: reason, maxPriceCents, guessedPriceCents });
    console.log(`\n⚠️ ${reason} — session frozen (${pausedSessionId})`);
    return { success: false, bookedDate, bookedTime, error: reason, screenshots, pausedSessionId, durationMs: durationMs(), polls: noPolls };
  }

  // Reached a matching checkout → drive the purchase flow with the fail-closed cap.
  let purchased = false;
  let purchaseErr = '';
  try {
    purchased = await handlePurchaseFlow(winner.page, dryRun, screenshots, maxPriceCents);
  } catch (err) {
    purchaseErr = errMsg(err);
    console.error(`   ❌ purchase flow threw: ${purchaseErr}`);
  }
  if (purchased) {
    console.log(dryRun
      ? `\n🧪 Volley DRY RUN reached checkout (no purchase): ${bookedDate} ${bookedTime}`
      : `\n🎉 Volley purchased: ${bookedDate} ${bookedTime}`);
    return { success: true, bookedDate, bookedTime, dryRun, screenshots, durationMs: durationMs(), polls: noPolls };
  }

  // Purchase didn't complete (cap-abort, dry run, or checkout failure) → freeze for recovery.
  const shot = await safeShot(winner.page); if (shot) screenshots.push(shot);
  if (dryRun) {
    return { success: false, bookedDate, bookedTime, dryRun: true, error: `Dry run: volley HELD but checkout did not complete${purchaseErr ? ' — ' + purchaseErr : ''}`, screenshots, durationMs: durationMs(), polls: noPolls };
  }
  setFrozen(winner.browser);
  const pausedSessionId = freezeSession({ handle: { browser: winner.browser, page: winner.page }, restaurant: req.restaurant, bookedDate, bookedTime, error: 'volley HELD but purchase failed', maxPriceCents, guessedPriceCents });
  console.log(`\n⚠️ Volley HELD but purchase failed — session frozen (${pausedSessionId})`);
  return { success: false, bookedDate, bookedTime, error: `Volley HELD but purchase failed — session frozen for recovery${purchaseErr ? ' — ' + purchaseErr : ''}`, screenshots, pausedSessionId, durationMs: durationMs(), polls: noPolls };
}

/**
 * Sniper engine: warm a small browser pool on the search page, densely poll the
 * search page's embedded availability ($REDUX_STATE) across the drop window, and let the
 * first loop to find a matching slot (EXACT date, closest in-window time, price-capped)
 * win an atomic lock, grab it (reload-on-hit DOM-click), and auto-purchase. Records what
 * it saw for diagnosis. On purchase failure the winning browser is frozen for recovery.
 *
 * When `cfg.volleyFire` is set, the T0 Volley engine (runVolleyMode) replaces the poll→lock
 * critical path with a pre-fired, pre-authenticated in-page lock burst (§1); the legacy poll
 * path below is preserved verbatim for `volleyFire` false.
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
  // Fast-vs-navigate poll accounting (speed + Cloudflare-throttle visibility).
  const pathStats: PathStats = { fast: 0, nav: 0, challenges: 0 };
  const pollStats = () => ({ total: pollTotal, matched: pollMatched, fast: pathStats.fast, nav: pathStats.nav, challenges: pathStats.challenges });

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
        const w: Warm = { browser, page };
        captureTockHeaders(page, w); // fills w.tockHeaders as the app makes its own API calls
        // The warm-up navigation intermittently draws a Cloudflare "Just a moment…" challenge
        // on the Railway IP (confirmed FHH + n/naka 2026-07-05) — the app never boots, so no
        // x-tock headers. It's INTERMITTENT (FHH's warm loaded fine on 2026-07-03), so retry
        // the navigation until the app actually boots (window.store present). Warm-up is not
        // time-critical (runs before the drop window), so a few retries are free.
        let booted = false;
        for (let attempt = 1; attempt <= 5 && !booted; attempt++) {
          await page.goto(searchUrlFor(req, req.dates[0]), { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
          for (let t = 0; t < 6000; t += 300) {
            booted = await page.evaluate(() => !!(globalThis as any).store?.getState || !!(globalThis as any).sessionStorage?.getItem('tock_session')).catch(() => false);
            if (booted || w.tockHeaders) { booted = true; break; }
            await sleep(300);
          }
          if (!booted) { console.log(`   browser #${i + 1} warm attempt ${attempt}: Cloudflare challenge / app not booted — retrying`); await sleep(1500); }
        }
        // headers from request-capture if the app fired them, else reconstruct from page state.
        if (!w.tockHeaders) { w.tockHeaders = (await readTockHeadersFromPage(page)) ?? undefined; w.headerSource = w.tockHeaders ? 'page' : 'none'; }
        else { w.headerSource = 'request'; }
        warm[i] = w;
        console.log(`   browser #${i + 1} warm (booted=${booted}, headers: ${w.headerSource})`);
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

    // --- T0 VOLLEY FIRE (§1, Task 7): pre-fired lock volley path. Behind cfg.volleyFire so the
    // legacy poll path below is untouched when false. The volley owns the drop from here: it
    // calibrates the clock, reconciles experience/price, freezes headers, arms fireVolley on all
    // pages (disjoint partitions) + watchPopulateEdge, ignites off min(computed fireAt, populate
    // edge) under the SingleWinnerLock, and hands the first HELD to the existing checkout tail /
    // freeze fallback. It sets frozenBrowser (so the finally block spares a handed-off session). ---
    if (cfg.volleyFire) {
      return await runVolleyMode(req, cfg, live, {
        base: dropAnchorEpoch(runAt),
        runAt,
        startTime,
        maxPriceCents,
        setFrozen: (b) => { frozenBrowser = b; },
      });
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
      const fastState: FastState = { useFast: cfg.fastPoll !== false, fastFails: 0 };
      try {
        const startAt = base + offsets[i];
        const waitMs = startAt - Date.now();
        if (waitMs > 0) await sleep(waitMs);

        // `<=` so the loop whose start offset equals windowEnd still polls once.
        while (Date.now() <= windowEnd && !lock.won) {
          let slots: NormalizedSlot[] = [];
          let lastErr = '';
          // One read per poll: calendar.offerings carries the WHOLE calendar (openDate spans
          // ~3 months), so a single fetch covers every requested date. Fast in-page-fetch path
          // first, navigate fallback on miss. We then check each req.date against it below.
          const offerings = await readOfferings(w.page, searchUrlFor(req, req.dates[0]), fastState, pathStats);
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

    // Proceed to the grab the INSTANT a winner exists — awaiting all loops first left the
    // detected slot un-grabbed for as long as a straggler's in-flight poll (typically
    // ~0.5s, up to ~40s if a loser is stuck in the navigate fallback). Loser loops exit
    // at their next lock.won check; their bodies are fully try/caught, so letting them
    // settle in the background (browsers closed in the finally) is safe. With no winner,
    // the wait runs to completion so `outcomes`/`seen` are complete for diagnosis.
    let loopsDone = false;
    void Promise.allSettled(loops).then(() => { loopsDone = true; });
    while (!winner && !loopsDone) await sleep(50);
    const durationMs = () => Date.now() - startTime;
    const seen = buildSeen();

    if (!winner || !bookedDate || !winnerSlot) {
      // No match — capture what one browser sees + the structured `seen` data, so we know
      // whether the target date/time was ever present (vs sold-out vs blocked). No black box.
      const shot = live[0] ? await safeShot(live[0].page) : null;
      // "No time matched" with in-window times visible usually means the PRICE filter
      // rejected them — say so, or a cap-miss reads like a mysterious window-miss.
      // (priceCentsSeen is the LAST price seen anywhere, so phrase as likely, not certain.)
      const capNote = maxPriceCents != null && seen.priceCentsSeen != null && seen.priceCentsSeen * req.partySize > maxPriceCents
        ? ` — likely PRICE-CAPPED: last seen $${(seen.priceCentsSeen / 100).toFixed(0)}/person × ${req.partySize} = $${(seen.priceCentsSeen * req.partySize / 100).toFixed(0)} exceeds cap $${(maxPriceCents / 100).toFixed(0)}`
        : '';
      const why = seen.anyTargetDate
        ? `requested date was bookable but no time matched (window ${cfg.timeWindowStart24 ?? 'any'}–${cfg.timeWindowEnd24 ?? 'any'}); times seen on target date: [${seen.targetDateTimes.join(', ') || 'none'}]${capNote}`
        : 'requested date never became bookable in the window';
      // WARM-UP HEALTH probe: did the app actually load (headers/store) or is the warm page a
      // Cloudflare challenge? Reveals for a sold-out restaurant (e.g. FHH) whether the
      // reload-free API grab would even have headers at the real drop.
      const warmProbe = live[0] ? await live[0].page.evaluate(() => {
        const g: any = globalThis;
        return { hdrs: undefined, ss: !!g.sessionStorage?.getItem('tock_session'), fp: !!g.localStorage?.getItem('fingerprint'), hasStore: !!g.store?.getState, title: (g.document?.title || '').slice(0, 24) };
      }).catch(() => null) : null;
      const warmDiag = warmProbe ? ` · [warm: src=${live[0].headerSource}, ss=${warmProbe.ss}, fp=${warmProbe.fp}, store=${warmProbe.hasStore}, title="${warmProbe.title}"]` : '';
      console.log(`\n❌ Sniper no match — ${why}`);
      return { success: false, error: `No matching slot in window — ${why} · ${summarizeFailures(outcomes)}${warmDiag}`, durationMs: durationMs(), polls: pollStats(), seen, screenshots: shot ? [shot] : undefined };
    }

    // --- Phase 3: grab + purchase (or rehearse, if dryRun) ---
    const dryRun = cfg.dryRun ?? false;
    const screenshots: string[] = [];
    let grab: GrabResult = { ok: false, reason: 'grab not attempted' };

    // PRIMARY grab: direct-API lock (Cloudflare-proof — no reload, so no Turnstile). Requires
    // the captured x-tock headers and the experience id from the poll.
    const expId = winnerSlot.offerId != null ? Number(winnerSlot.offerId) : NaN;
    // Last-chance header read at GRAB time (the page has been alive far longer than at warm —
    // the app has had time to init sessionStorage even on modal pages).
    if (cfg.apiGrab !== false && !winner.tockHeaders) {
      const late = await readTockHeadersFromPage(winner.page);
      if (late) { winner.tockHeaders = late; winner.headerSource = 'page-grab'; }
    }
    let apiDiag = 'API grab off'; // surfaced in the final error so history shows the API path
    if (cfg.apiGrab !== false && winner.tockHeaders && Number.isFinite(expId)) {
      grab = await grabViaApi(winner.page, req.restaurant, bookedDate, winnerSlot.time24, req.partySize, expId, winnerSlot.seatingAreaId, winner.tockHeaders, winnerSlot.priceCents ?? 0);
      apiDiag = `hdrs:${winner.headerSource}, ` + (grab.ok ? (grab.heldNoCheckout ? 'API held (no auto-checkout)' : 'API held + checkout') : `API: ${grab.reason}`);
      if (!grab.ok) console.log(`   ⚠️ API grab failed (${grab.reason}) — falling back to reload+click`);
    } else if (cfg.apiGrab !== false) {
      // Probe WHY headers are missing so the failure is diagnosable from history.
      const probe = await winner.page.evaluate(() => {
        const g: any = globalThis;
        return {
          ss: !!g.sessionStorage?.getItem('tock_session'),
          fp: !!g.localStorage?.getItem('fingerprint'),
          url: g.location?.pathname,
          challenged: /verify you are human|just a moment/i.test(g.document?.body?.innerText || ''),
          hasStore: !!g.store?.getState,
          title: (g.document?.title || '').slice(0, 28),
        };
      }).catch((e: unknown) => ({ err: String(e) }));
      apiDiag = `API skipped: no headers (reqs:${winner.tockHeaderHits ?? 0}, probe:${JSON.stringify(probe)})`;
      console.log(`   ⚠️ ${apiDiag} — using reload+click`);
    }

    // The API lock may HOLD the slot yet fail to auto-reach checkout (paid flows need the
    // client-side Book click — a fresh /checkout load redirects). Remember that: the slot is
    // already held, so the reload+click below is unhurried (a challenge on its reload is
    // retryable), and if it can't reach checkout either we still freeze the held slot.
    const apiHeld = grab.ok === true && grab.heldNoCheckout === true;
    const apiHeldResult = apiHeld ? grab : null;

    // reload+click grab: reaches checkout via the client-side Book click. Runs when the API
    // grab didn't fully succeed (failed, or held-without-checkout). A lost click race is
    // retryable — grab the next surviving in-window time, excluding what already failed.
    const excludedTimes: string[] = [];
    const grabDeadline = Date.now() + 25000;
    if (!grab.ok || apiHeld) {
      let dom: GrabResult = { ok: false, reason: 'reload+click not attempted' };
      for (let attempt = 1; attempt <= 3; attempt++) {
        dom = await grabViaDom(winner.page, bookedDate, winnerSlot.time24, cfg.timeWindowStart24, cfg.timeWindowEnd24, excludedTimes);
        if (dom.ok || !dom.slotTakenAtClick || !dom.failedTime12 || Date.now() > grabDeadline) break;
        excludedTimes.push(dom.failedTime12);
      }
      // Prefer a reload+click that actually reached checkout. Otherwise, if the API lock had
      // held the slot, keep that held result (freeze for manual completion) rather than the
      // reload's failure — the slot is genuinely secured.
      if (dom.ok && !(dom as { heldNoCheckout?: boolean }).heldNoCheckout) grab = dom;
      else if (apiHeldResult) grab = apiHeldResult;
      else grab = dom;
    }
    if (!grab.ok) {
      const shot = await safeShot(winner.page); if (shot) screenshots.push(shot);
      const lostRaces = excludedTimes.length ? ` (lost click races on: ${excludedTimes.join(', ')})` : '';
      return { success: false, bookedDate, bookedTime: winnerSlot.time12, dryRun, error: `Grab failed: ${grab.reason}${lostRaces} · [${apiDiag}]`, screenshots, durationMs: durationMs(), polls: pollStats(), seen };
    }
    // The grab may have fallen back to a different surviving time — report what was held.
    bookedTime = grab.time12 ?? winnerSlot.time12;

    // The API grab held the slot but could NOT auto-reach a matching checkout (redirect,
    // persistent challenge, or a wrong-date guard trip). Don't burn 30s driving a purchase
    // flow on a non-checkout page — freeze the held slot so a human completes it inside the
    // ~10-min window, with an unambiguous reason (distinct from a checkout that hung).
    if (grab.ok && grab.heldNoCheckout) {
      const shot = await safeShot(winner.page); if (shot) screenshots.push(shot);
      const reason = `API lock HELD ${bookedDate} ${bookedTime} but checkout not auto-reached — open the frozen session and complete it manually (verify the date first)`;
      if (dryRun) {
        return { success: false, bookedDate, bookedTime, dryRun: true, error: `Dry run: ${reason}`, screenshots, durationMs: durationMs(), polls: pollStats(), seen };
      }
      frozenBrowser = winner.browser;
      const pausedSessionId = freezeSession({ handle: { browser: winner.browser, page: winner.page }, restaurant: req.restaurant, bookedDate, bookedTime, error: reason, maxPriceCents });
      console.log(`\n⚠️ ${reason} — session frozen (${pausedSessionId})`);
      return { success: false, bookedDate, bookedTime, error: reason, screenshots, pausedSessionId, durationMs: durationMs(), polls: pollStats(), seen };
    }

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
      purchaseErr = errMsg(err);
      console.error(`   ❌ purchase flow threw: ${purchaseErr}`);
      outcomes.push({ attempt: 1, status: 'crashed', error: `purchase: ${purchaseErr}` });
    }

    if (purchased) {
      console.log(dryRun
        ? `\n🧪 Sniper DRY RUN reached checkout (no purchase): ${bookedDate} ${bookedTime}`
        : `\n🎉 Sniper purchased: ${bookedDate} ${bookedTime}`);
      return { success: true, bookedDate, bookedTime, dryRun, screenshots, durationMs: durationMs(), polls: pollStats(), seen };
    }

    // A rehearsal (or a price-capped/failed checkout) didn't complete — report it, don't freeze.
    const shot = await safeShot(winner.page); if (shot) screenshots.push(shot);
    if (dryRun) {
      return { success: false, bookedDate, bookedTime, dryRun: true, error: `Dry run: grabbed the slot but checkout did not complete${purchaseErr ? ' — ' + purchaseErr : ''}`, screenshots, durationMs: durationMs(), polls: pollStats(), seen };
    }

    // Real purchase failed: freeze the winning session for human recovery (slot held ~10 min).
    frozenBrowser = winner.browser;
    const pausedSessionId = freezeSession({
      handle: { browser: winner.browser, page: winner.page },
      restaurant: req.restaurant, bookedDate, bookedTime,
      error: 'purchase failed after grab', maxPriceCents,
    });
    console.log(`\n⚠️ Sniper grabbed but purchase failed — session frozen (${pausedSessionId})`);
    return { success: false, bookedDate, bookedTime, error: `Grabbed the slot but purchase failed — session frozen for recovery${purchaseErr ? ' — ' + purchaseErr : ''}`, screenshots, pausedSessionId, durationMs: durationMs(), polls: pollStats(), seen };

  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : String(err), durationMs: Date.now() - startTime, polls: pollStats() };
  } finally {
    // Close every browser EXCEPT the one handed off to a frozen session.
    await Promise.allSettled(warm.map(w => (w && w.browser !== frozenBrowser) ? w.browser.close() : Promise.resolve()));
  }
}

