import { chromium, Browser, Page } from 'playwright';
import { BookingRequest, STEALTH_ARGS, to12Hour, handlePurchaseFlow } from './booker';
import { injectCookies } from './cookies';
import { getFingerprint, summarizeFailures, safeShot, AttemptOutcome } from './blitz';
import { freezeSession } from './sessions';

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
  // `fast`/`nav` = polls served by the fast in-page-fetch vs the navigate fallback;
  // `challenges` = polls where the fast fetch hit a Cloudflare challenge (throttle signal).
  polls: { total: number; matched: number; fast?: number; nav?: number; challenges?: number };
  seen?: SniperSeen;       // instrumentation: what availability the bot observed
}

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

interface FastState { useFast: boolean; fastFails: number; }
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
 *  f6=0, f13=seatingAreaId (omitted for direct-book venues). All values come from the poll's
 *  offerings data. Verified byte-identical to a real click-generated lock. */
export function encodeTockLock(partySize: number, dateTime: string, experienceId: number, seatingAreaId?: number): Buffer {
  const w = (arr: number[], n: number) => { let v = Math.floor(n); while (v > 0x7f) { arr.push((v & 0x7f) | 0x80); v = Math.floor(v / 128); } arr.push(v & 0x7f); };
  const field = (arr: number[], f: number, wire: number) => w(arr, f * 8 + wire);
  const inner: number[] = [];
  field(inner, 1, 0); w(inner, partySize);
  field(inner, 2, 2); { const b = Buffer.from(dateTime, 'utf8'); w(inner, b.length); for (const x of b) inner.push(x); }
  field(inner, 3, 0); w(inner, experienceId);
  field(inner, 6, 0); w(inner, 0);
  if (seatingAreaId != null && Number.isFinite(seatingAreaId)) { field(inner, 13, 0); w(inner, seatingAreaId); }
  const outer: number[] = [];
  field(outer, 60051, 2); w(outer, inner.length); for (const x of inner) outer.push(x);
  return Buffer.from(outer);
}

/** Classify a `PUT /api/ticket/group/lock` response. The endpoint returns HTTP 200 for BOTH
 *  a real hold and a conflict (the conflict body is a short human-readable error like
 *  "someone else just selected this and it is no longer available" — confirmed live on
 *  n/naka 2026-07-05, ~89 bytes; a real lock is a large protobuf, ~1200+ bytes, echoing the
 *  reservation). Checking only the status/size would treat a conflict as a win and skip the
 *  fallback. `text` is the response body's printable chars.
 *   - 'blocked'  → not even a lock response (HTML interstitial / network error) → fall back
 *   - 'conflict' → 200 but the slot was taken → retry another time / fall back
 *   - 'held'     → a genuine lock */
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
): Promise<GrabResult> {
  // Normalize the time to zero-padded 24h "HH:MM" — the lock datetime must match Tock's format
  // exactly (a stray "9:00" would build a lock the server rejects).
  const tm = /^(\d{1,2}):(\d{2})$/.exec(time24.trim());
  const normTime = tm ? `${tm[1].padStart(2, '0')}:${tm[2]}` : time24.trim();
  const dateTime = `${date}T${normTime}`;
  const bodyB64 = encodeTockLock(partySize, dateTime, experienceId, seatingAreaId).toString('base64');
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
        await page.goto(searchUrlFor(req, req.dates[0]), { waitUntil: 'domcontentloaded', timeout: 30000 });
        // The app's x-tock-header-bearing calls fire ~1-2s after domcontentloaded — settle
        // until the listener has captured them so the direct-API grab has headers ready even
        // if the drop window starts immediately.
        for (let t = 0; t < 5000 && !w.tockHeaders; t += 250) await sleep(250);
        // Modal-UI restaurants (n/naka, FHH) fire NO x-tock request passively on the server —
        // reconstruct the headers from page state so the API grab still works.
        if (!w.tockHeaders) { w.tockHeaders = (await readTockHeadersFromPage(page)) ?? undefined; w.headerSource = w.tockHeaders ? 'page' : 'none'; }
        else { w.headerSource = 'request'; }
        warm[i] = w;
        console.log(`   browser #${i + 1} warm (headers: ${w.headerSource})`);
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
      console.log(`\n❌ Sniper no match — ${why}`);
      return { success: false, error: `No matching slot in window — ${why} · ${summarizeFailures(outcomes)}`, durationMs: durationMs(), polls: pollStats(), seen, screenshots: shot ? [shot] : undefined };
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
      grab = await grabViaApi(winner.page, req.restaurant, bookedDate, winnerSlot.time24, req.partySize, expId, winnerSlot.seatingAreaId, winner.tockHeaders);
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
      const pausedSessionId = freezeSession({ handle: { browser: winner.browser, page: winner.page }, restaurant: req.restaurant, bookedDate, bookedTime, error: reason });
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
      error: 'purchase failed after grab',
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

