import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  pickSlot,
  pickBestSlot,
  timeToMin,
  SingleWinnerLock,
  computeWindowOffsets,
  parseAvailability,
  validateSniperConfig,
  NormalizedSlot,
  SniperConfig,
  nearestTimeText,
  clickSeatingAreaForTime,
  time12ToMin,
  pickFallbackTime12,
  holdStateFromPage,
  encodeTockLock,
  checkoutDateString,
  lockResponseVerdict,
  buildCandidateBodies,
  classifyLock,
  parseLockEcho,
  resolveWantedCells,
  partitionCandidates,
  LockCandidate,
} from '../src/sniper';
import { BookingRequest } from '../src/booker';

// Compare only the date/time12/offerId of slots (ignore time24/priceCents) where those are the focus.
const core = (arr: NormalizedSlot[]) => arr.map(s => ({ date: s.date, time12: s.time12, offerId: s.offerId }));
const slot = (date: string, time24: string, time12: string, offerId: string, priceCents?: number): NormalizedSlot =>
  ({ date, time24, time12, offerId, priceCents });

// --- timeToMin ---
test('timeToMin converts 24h to minutes-of-day', () => {
  assert.equal(timeToMin('00:00'), 0);
  assert.equal(timeToMin('17:30'), 1050);
  assert.equal(timeToMin('23:45'), 1425);
});

// --- pickSlot (strict exact date+time) ---
const strictSlots: NormalizedSlot[] = [
  slot('2026-07-15', '17:00', '5:00 PM', 'a'),
  slot('2026-07-15', '19:00', '7:00 PM', 'b'),
];

test('pickSlot exact match on date+time', () => {
  assert.equal(pickSlot(strictSlots, '2026-07-15', '19:00')?.offerId, 'b');
});
test('pickSlot returns null when date absent', () => {
  assert.equal(pickSlot(strictSlots, '2026-07-16', '19:00'), null);
});
test('pickSlot returns null when time absent (strict, no fallback)', () => {
  assert.equal(pickSlot(strictSlots, '2026-07-15', '20:00'), null);
});

// --- pickBestSlot (exact date, flexible time) ---
const flexSlots: NormalizedSlot[] = [
  slot('2026-07-28', '17:30', '5:30 PM', 'x', 42000),
  slot('2026-07-28', '18:15', '6:15 PM', 'x', 42000),
  slot('2026-07-28', '19:00', '7:00 PM', 'x', 42000),
  slot('2026-07-29', '18:00', '6:00 PM', 'y', 42000),
];

test('pickBestSlot grabs the time CLOSEST to target on the requested date', () => {
  // target 18:00, no exact match on 07-28 → closest is 18:15
  const m = pickBestSlot(flexSlots, ['2026-07-28'], '18:00');
  assert.equal(m?.time12, '6:15 PM');
});

test('pickBestSlot honors the time window (excludes out-of-window slots)', () => {
  // window 18:30–20:00 → only 19:00 qualifies on 07-28
  const m = pickBestSlot(flexSlots, ['2026-07-28'], '18:00', { windowStart24: '18:30', windowEnd24: '20:00' });
  assert.equal(m?.time12, '7:00 PM');
});

test('pickBestSlot returns null when no slot is within the window', () => {
  const m = pickBestSlot(flexSlots, ['2026-07-28'], '18:00', { windowStart24: '21:00', windowEnd24: '22:00' });
  assert.equal(m, null);
});

test('pickBestSlot never crosses to a different date (anti-wrong-date)', () => {
  // 07-30 not present; must NOT fall back to 07-28/07-29
  assert.equal(pickBestSlot(flexSlots, ['2026-07-30'], '18:00'), null);
});

test('pickBestSlot honors date priority order', () => {
  // both dates available; 07-29 listed first → pick its slot
  const m = pickBestSlot(flexSlots, ['2026-07-29', '2026-07-28'], '18:00');
  assert.equal(m?.offerId, 'y');
  assert.equal(m?.date, '2026-07-29');
});

test('pickBestSlot rejects slots over the price cap', () => {
  const pricey = [slot('2026-07-28', '18:00', '6:00 PM', 'z', 90000)];
  assert.equal(pickBestSlot(pricey, ['2026-07-28'], '18:00', { maxPriceCents: 50000 }), null);
  assert.equal(pickBestSlot(pricey, ['2026-07-28'], '18:00', { maxPriceCents: 100000 })?.offerId, 'z');
});

test('pickBestSlot allows slots with unknown price (price enforced at purchase)', () => {
  const noPrice = [slot('2026-07-28', '18:00', '6:00 PM', 'np')]; // priceCents undefined
  assert.equal(pickBestSlot(noPrice, ['2026-07-28'], '18:00', { maxPriceCents: 1000 })?.offerId, 'np');
});

test('pickBestSlot price cap is on the TOTAL (per-person × party size)', () => {
  const s = [slot('2026-07-28', '18:00', '6:00 PM', 'z', 30000)]; // $300 per person
  // party 2 → estimated total $600: a $500 cap rejects, a $700 cap allows.
  assert.equal(pickBestSlot(s, ['2026-07-28'], '18:00', { maxPriceCents: 50000, partySize: 2 }), null);
  assert.equal(pickBestSlot(s, ['2026-07-28'], '18:00', { maxPriceCents: 70000, partySize: 2 })?.offerId, 'z');
  // same per-person price, party 1 → total $300, under the $500 cap → allowed.
  assert.equal(pickBestSlot(s, ['2026-07-28'], '18:00', { maxPriceCents: 50000, partySize: 1 })?.offerId, 'z');
});

// --- validateSniperConfig (fail-closed gate on the money/time fields) ---
// baseCfg is a DRY run: capless is only legal when no purchase can happen.
const baseCfg: SniperConfig = { pool: 5, pollIntervalMs: 200, windowStartMs: -1000, windowEndMs: 10000, dryRun: true };

test('validateSniperConfig accepts a clean config (with and without a cap)', () => {
  assert.equal(validateSniperConfig(baseCfg), null);
  assert.equal(validateSniperConfig({ ...baseCfg, maxPriceCents: 50000, timeWindowStart24: '18:00', timeWindowEnd24: '20:00' }), null);
});

test('validateSniperConfig requires a price cap for a real (non-dry) run', () => {
  // No cap + no dryRun = no overspend guard: must be rejected at every gate.
  assert.match(validateSniperConfig({ ...baseCfg, dryRun: false }) ?? '', /maxPriceCents is required/);
  assert.match(validateSniperConfig({ pool: 5, pollIntervalMs: 200, windowStartMs: -1000, windowEndMs: 10000 }) ?? '', /maxPriceCents is required/);
  // With a cap, a real run is legal.
  assert.equal(validateSniperConfig({ ...baseCfg, dryRun: false, maxPriceCents: 70000 }), null);
});

test('validateSniperConfig rejects a non-positive or non-finite price cap', () => {
  assert.ok(validateSniperConfig({ ...baseCfg, maxPriceCents: 0 }));
  assert.ok(validateSniperConfig({ ...baseCfg, maxPriceCents: -100 }));
  assert.ok(validateSniperConfig({ ...baseCfg, maxPriceCents: NaN }));
  // A non-number sneaking in from the HTTP body must be rejected, not silently coerced.
  assert.ok(validateSniperConfig({ ...baseCfg, maxPriceCents: '50000' as any }));
});

test('validateSniperConfig rejects malformed time windows', () => {
  assert.ok(validateSniperConfig({ ...baseCfg, timeWindowStart24: '6pm' }));
  assert.ok(validateSniperConfig({ ...baseCfg, timeWindowEnd24: '20' }));
});

// --- SingleWinnerLock ---
test('SingleWinnerLock grants exactly one winner', () => {
  const lock = new SingleWinnerLock();
  const results = [lock.tryAcquire(), lock.tryAcquire(), lock.tryAcquire()];
  assert.equal(results.filter(Boolean).length, 1);
  assert.equal(results[0], true);
  assert.equal(lock.won, true);
});

// --- computeWindowOffsets ---
test('computeWindowOffsets spans the window inclusively', () => {
  assert.deepEqual(computeWindowOffsets(5, -1000, 10000), [-1000, 1750, 4500, 7250, 10000]);
});
test('computeWindowOffsets pool=1 starts at window start', () => {
  assert.deepEqual(computeWindowOffsets(1, -1000, 10000), [-1000]);
});
test('computeWindowOffsets pool=2 hits both endpoints', () => {
  assert.deepEqual(computeWindowOffsets(2, -1000, 10000), [-1000, 10000]);
});
test('computeWindowOffsets clamps non-positive pool to a single offset', () => {
  assert.deepEqual(computeWindowOffsets(0, -1000, 10000), [-1000]);
});
test('computeWindowOffsets handles a zero-width window without NaN', () => {
  assert.deepEqual(computeWindowOffsets(3, 5000, 5000), [5000, 5000, 5000]);
});

// --- parseAvailability (Tock calendar.offerings model) ---
test('parseAvailability builds slots (date/time12/offerId) from openDate × openTime', () => {
  const offerings = {
    openDate: ['2026-07-22'],
    openTime: ['17:00', '19:00'],
    experience: [{ id: 612271, state: 'AVAILABLE', partySize: [2, 3] }],
  };
  assert.deepEqual(core(parseAvailability(offerings, 2)), [
    { date: '2026-07-22', time12: '5:00 PM', offerId: '612271' },
    { date: '2026-07-22', time12: '7:00 PM', offerId: '612271' },
  ]);
});

test('parseAvailability carries 24h time and per-person price', () => {
  const offerings = {
    openDate: ['2026-07-22'],
    openTime: ['18:00'],
    experience: [{
      id: 9, state: 'AVAILABLE', partySize: [2],
      price: { partyRangeConfigs: [{ ticketPriceInformation: { amountCents: 42000 } }] },
    }],
  };
  assert.deepEqual(parseAvailability(offerings, 2), [
    { date: '2026-07-22', time24: '18:00', time12: '6:00 PM', offerId: '9', priceCents: 42000 },
  ]);
});

test('parseAvailability reads price from the flat ticketPriceInformation shape', () => {
  const offerings = {
    openDate: ['2026-07-22'], openTime: ['18:00'],
    experience: [{ id: 9, state: 'AVAILABLE', partySize: [2], ticketPriceInformation: { amountCents: 32000 } }],
  };
  assert.equal(parseAvailability(offerings, 2)[0].priceCents, 32000);
});

test('parseAvailability returns [] when no AVAILABLE experience matches the party size', () => {
  const offerings = {
    openDate: ['2026-07-22'], openTime: ['19:00'],
    experience: [
      { id: 1, state: 'SOLD', partySize: [2] },
      { id: 2, state: 'AVAILABLE', partySize: [4, 5] },
    ],
  };
  assert.deepEqual(parseAvailability(offerings, 2), []);
});

test('parseAvailability converts noon/midnight/12:30 correctly (24h→12h)', () => {
  const offerings = {
    openDate: ['2026-07-22'], openTime: ['00:00', '12:00', '12:30'],
    experience: [{ id: 5, state: 'AVAILABLE', partySize: [2] }],
  };
  assert.deepEqual(core(parseAvailability(offerings, 2)).map(s => s.time12), ['12:00 AM', '12:00 PM', '12:30 PM']);
});

test('parseAvailability emits the full date × time cross-product (dates outer)', () => {
  const offerings = {
    openDate: ['2026-07-22', '2026-07-23'], openTime: ['17:00', '19:00'],
    experience: [{ id: 9, state: 'AVAILABLE', partySize: [2] }],
  };
  assert.deepEqual(core(parseAvailability(offerings, 2)), [
    { date: '2026-07-22', time12: '5:00 PM', offerId: '9' },
    { date: '2026-07-22', time12: '7:00 PM', offerId: '9' },
    { date: '2026-07-23', time12: '5:00 PM', offerId: '9' },
    { date: '2026-07-23', time12: '7:00 PM', offerId: '9' },
  ]);
});

test('parseAvailability skips experiences missing partySize without throwing', () => {
  const offerings = {
    openDate: ['2026-07-22'], openTime: ['19:00'],
    experience: [
      { id: 1, state: 'AVAILABLE' },
      { id: 2, state: 'AVAILABLE', partySize: [2] },
    ],
  };
  assert.deepEqual(core(parseAvailability(offerings, 2)), [{ date: '2026-07-22', time12: '7:00 PM', offerId: '2' }]);
});

test('parseAvailability excludes experiences whose state is not exactly AVAILABLE', () => {
  const offerings = {
    openDate: ['2026-07-22'], openTime: ['19:00'],
    experience: [
      { id: 1, state: 'WAITLIST', partySize: [2] },
      { id: 2, state: undefined as any, partySize: [2] },
      { id: 3, state: 'available', partySize: [2] },
    ],
  };
  assert.deepEqual(parseAvailability(offerings, 2), []);
});

test('parseAvailability tolerates null and empty offerings', () => {
  assert.deepEqual(parseAvailability(null, 2), []);
  assert.deepEqual(parseAvailability({ openDate: [], openTime: [], experience: [] }, 2), []);
});

// --- nearestTimeText: scopes a button to its own card's time ---
// Models the DOM as a parentElement chain. textContent on a real node includes all
// descendant text, so ancestors ABOVE the card carry every card's times — the walk-up
// must stop at the nearest time-bearing ancestor (the card) or a multi-card page would
// always match the first card on the page.

const chainNode = (textContent: string, parentElement: any = null) => ({ textContent, parentElement });

test('nearestTimeText returns the nearest ancestor time (the button\'s own card)', () => {
  const page = chainNode('6:45 PMDining Room · CounterBook7:00 PMDining Room · CounterBook');
  const card = chainNode('7:00 PMDining Room · CounterBook', page);
  const row = chainNode('Dining Room', card);
  const btn = chainNode('Dining Room', row);
  assert.equal(nearestTimeText(btn), '7:00 PM');
});

test('nearestTimeText does not leak a sibling card\'s time through a shared container', () => {
  const page = chainNode('6:45 PM…7:00 PM…7:15 PM…');
  const otherCard = chainNode('6:45 PMBook', page);
  const card = chainNode('7:15 PMDining Room · CounterBook', page);
  const btn = chainNode('Counter', chainNode('Counter', card));
  assert.equal(nearestTimeText(btn), '7:15 PM'); // card wins, not 6:45 from `page`
  assert.equal(nearestTimeText(chainNode('Book', otherCard)), '6:45 PM');
});

test('nearestTimeText returns empty when no ancestor within 10 levels has a time', () => {
  let node: any = chainNode('no times anywhere');
  for (let i = 0; i < 12; i++) node = chainNode('still none', node);
  assert.equal(nearestTimeText(node), '');
  assert.equal(nearestTimeText(null), '');
});

test('nearestTimeText matches AM/PM case-insensitively and single-digit hours', () => {
  const card = chainNode('9:15 am · Patio');
  assert.equal(nearestTimeText(chainNode('Patio', card)), '9:15 am');
});

// --- clickSeatingAreaForTime branch coverage (faked Playwright page/elements) ---
// The function's contract: a throw BEFORE the chooser is known to exist is the direct-book
// flow racing to checkout (ok); once seating options are found, Book did NOT navigate, so
// every failure is real and must carry a reason (never masked as ok).

const fakeArea = (opts: { time?: string; visible?: boolean; testid?: string; clickThrows?: boolean; evaluateThrows?: boolean; onClick?: () => void }) => ({
  isVisible: async () => opts.visible !== false,
  evaluate: async (fn: (el: any) => string) => {
    if (opts.evaluateThrows) throw new Error('Execution context was destroyed');
    return fn(chainNode('x', chainNode(`${opts.time ?? ''}Seating`)));
  },
  getAttribute: async () => opts.testid ?? null,
  click: async () => {
    if (opts.clickThrows) throw new Error('element is not attached to the DOM');
    opts.onClick?.();
  },
});
const fakePage = (areas: any[] | 'throws') => ({
  $$: async () => {
    if (areas === 'throws') throw new Error('Execution context was destroyed');
    return areas;
  },
});

test('clickSeatingAreaForTime: query throw before chooser is known = navigation, ok', async () => {
  const r = await clickSeatingAreaForTime(fakePage('throws') as any, '7:00 PM');
  assert.deepEqual(r, { ok: true });
});

test('clickSeatingAreaForTime: no seating buttons = direct-book flow, ok', async () => {
  const r = await clickSeatingAreaForTime(fakePage([]) as any, '7:00 PM');
  assert.deepEqual(r, { ok: true });
});

test('clickSeatingAreaForTime clicks the option scoped to the requested time', async () => {
  let clicked = '';
  const areas = [
    fakeArea({ time: '6:45 PM', testid: 'seating-area-40034', onClick: () => { clicked = '6:45'; } }),
    fakeArea({ time: '7:00 PM', testid: 'seating-area-40035', onClick: () => { clicked = '7:00'; } }),
  ];
  const r = await clickSeatingAreaForTime(fakePage(areas) as any, '7:00 PM');
  assert.deepEqual(r, { ok: true });
  assert.equal(clicked, '7:00'); // not the 6:45 sibling
});

test('clickSeatingAreaForTime: a throw AFTER the chooser exists is a real failure, not ok', async () => {
  const areas = [fakeArea({ time: '7:00 PM', evaluateThrows: true })];
  const r = await clickSeatingAreaForTime(fakePage(areas) as any, '7:00 PM');
  assert.equal(r.ok, false);
  assert.match((r as any).reason, /seating chooser handling failed: Execution context was destroyed/);
});

test('clickSeatingAreaForTime: no matching option reports what it saw', async () => {
  const areas = [fakeArea({ time: '6:45 PM' }), fakeArea({ time: '7:15 PM', visible: false })];
  const r = await clickSeatingAreaForTime(fakePage(areas) as any, '7:00 PM');
  assert.equal(r.ok, false);
  assert.match((r as any).reason, /2 options, 1 visible, times seen \[6:45 PM\], wanted 7:00 pm/);
});

test('clickSeatingAreaForTime: click failure carries the underlying error', async () => {
  const areas = [fakeArea({ time: '7:00 PM', clickThrows: true })];
  const r = await clickSeatingAreaForTime(fakePage(areas) as any, '7:00 PM');
  assert.equal(r.ok, false);
  assert.match((r as any).reason, /seating option click failed: element is not attached/);
});

// --- time12ToMin / pickFallbackTime12 (grab-time fallback when the picked slot vanished) ---

test('time12ToMin parses card labels incl. noon/midnight edges', () => {
  assert.equal(time12ToMin('7:00 PM'), 19 * 60);
  assert.equal(time12ToMin('9:15 am'), 9 * 60 + 15);
  assert.equal(time12ToMin('12:00 PM'), 12 * 60); // noon
  assert.equal(time12ToMin('12:30 AM'), 30);      // after midnight
  assert.equal(time12ToMin('Book'), null);
});

test('pickFallbackTime12 picks the closest surviving in-window time', () => {
  const times = ['5:00 PM', '5:15 PM', '8:00 PM'];
  // target 19:00 → 8:00 PM (60 min away) beats 5:15 PM (105 min away)
  assert.equal(pickFallbackTime12(times, '19:00', '17:00', '20:00'), '8:00 PM');
});

test('pickFallbackTime12 never leaves the accept window', () => {
  // Only out-of-window times survive → no fallback, run must fail rather than book 4 PM
  assert.equal(pickFallbackTime12(['4:00 PM', '9:30 PM'], '19:00', '17:00', '20:00'), null);
});

test('pickFallbackTime12 without a window considers everything and breaks ties earlier', () => {
  assert.equal(pickFallbackTime12(['4:00 PM', '9:30 PM'], '19:00'), '9:30 PM'); // 150 vs 180 min
  // 6:30 and 7:30 are both 30 min from 19:00 → earlier wins
  assert.equal(pickFallbackTime12(['7:30 PM', '6:30 PM'], '19:00'), '6:30 PM');
});

test('pickFallbackTime12 ignores unparseable labels and empty input', () => {
  assert.equal(pickFallbackTime12([], '19:00'), null);
  assert.equal(pickFallbackTime12(['Book', 'Notify'], '19:00'), null);
  assert.equal(pickFallbackTime12(['Book', '7:15 PM'], '19:00', '17:00', '20:00'), '7:15 PM');
});

// --- holdStateFromPage (post-click hold verification: the "button was enabled but the
// slot was already taken" race the owner has hit in the UI) ---

test('holdStateFromPage: checkout markers or leaving the search page = held', () => {
  assert.equal(holdStateFromPage(true, false, true), 'held');
  assert.equal(holdStateFromPage(false, false, false), 'held'); // navigated off search
  // checkout marker wins even if stale "no longer available" text lingers somewhere
  assert.equal(holdStateFromPage(true, true, true), 'held');
});

test('holdStateFromPage: "no longer available" on the search page = taken (retryable)', () => {
  assert.equal(holdStateFromPage(false, true, true), 'taken');
});

test('holdStateFromPage: nothing conclusive yet = pending (keep polling)', () => {
  assert.equal(holdStateFromPage(false, false, true), 'pending');
});

// --- encodeTockLock: the reverse-engineered PUT /api/ticket/group/lock protobuf body ---
// The reference b64 was captured live 2026-07-03 from a real JouJou click-generated lock
// (spike-lock-poc); our constructed bytes must be byte-identical for the same slot.

test('encodeTockLock is byte-identical to a real captured lock (multi-seating)', () => {
  // JouJou: size 2, 2026-07-21 18:30, experience 583810, seating 40034 (Dining Room).
  const b64 = encodeTockLock(2, '2026-07-21T18:30', 583810, 40034).toString('base64');
  assert.equal(b64, 'mqkdHggCEhAyMDI2LTA3LTIxVDE4OjMwGILRIzAAaOK4Ag==');
});

test('encodeTockLock omits the seating field for direct-book venues (FHH-shape)', () => {
  // No seatingAreaId → no f13. Decode both and confirm only the seating field differs.
  const withSeat = encodeTockLock(2, '2026-07-11T19:00', 559289, 40034);
  const noSeat = encodeTockLock(2, '2026-07-11T19:00', 559289);
  assert.ok(noSeat.length < withSeat.length, 'direct-book lock is shorter (no seating field)');
  // f13 tag = 13*8+0 = 104 = 0x68; present with seating, absent without.
  assert.ok(withSeat.includes(0x68), 'seating variant contains the f13 tag');
  assert.ok(!noSeat.includes(0x68), 'direct-book variant omits the f13 tag');
  // The datetime string is present in both.
  assert.ok(noSeat.toString('latin1').includes('2026-07-11T19:00'));
});

test('encodeTockLock varint-encodes large experience ids correctly', () => {
  // Round-trip the f3 experience id through a minimal decoder to guard the varint math.
  const buf = encodeTockLock(4, '2026-12-31T20:15', 1234567, 99999);
  const b = [...buf];
  // Walk to the f3 tag (24 = 3*8+0) and decode its varint.
  let i = b.indexOf(24, 3);
  assert.ok(i > -1, 'f3 tag present');
  i++; let val = 0, shift = 0;
  while (b[i] & 0x80) { val |= (b[i] & 0x7f) << shift; shift += 7; i++; }
  val |= b[i] << shift;
  assert.equal(val >>> 0, 1234567);
});

// --- checkoutDateString: wrong-slot guard renders the target date as Tock's checkout shows it ---
test('checkoutDateString formats YYYY-MM-DD as Tock renders it (no leading zero on day)', () => {
  assert.equal(checkoutDateString('2026-07-11'), 'July 11, 2026');
  assert.equal(checkoutDateString('2026-07-05'), 'July 5, 2026');
  assert.equal(checkoutDateString('2026-12-31'), 'December 31, 2026');
});
test('checkoutDateString returns null for malformed input (guard degrades safely)', () => {
  assert.equal(checkoutDateString('7/11/2026'), null);
  assert.equal(checkoutDateString('2026-13-01'), null);
  assert.equal(checkoutDateString(''), null);
});

// --- lockResponseVerdict: the lock endpoint returns HTTP 200 for BOTH held and conflict ---
test('lockResponseVerdict: a large protobuf body with no error text = held', () => {
  // A real lock echoes reservation details (restaurant/date/time), ~1200+ bytes.
  const real = 'JouJou Dinner Reservation 2026-07-21T18:30 ' + 'x'.repeat(1200);
  assert.equal(lockResponseVerdict(200, 'application/octet-stream', 1227, real), 'held');
});
test('lockResponseVerdict: HTTP 200 with a "no longer available" body = conflict (the n/naka bug)', () => {
  assert.equal(lockResponseVerdict(200, 'application/octet-stream', 89, 'W  M Unfortunately, someone else just selected this and it is no longer available. ('), 'conflict');
});
test('lockResponseVerdict: other conflict phrasings and a tiny 200 = conflict', () => {
  assert.equal(lockResponseVerdict(200, 'application/octet-stream', 60, 'this time is already taken'), 'conflict');
  assert.equal(lockResponseVerdict(200, 'application/octet-stream', 40, 'sold out'), 'conflict');
  assert.equal(lockResponseVerdict(200, 'application/octet-stream', 30, ''), 'conflict'); // tiny, no marker → still suspect
});
test('lockResponseVerdict: non-200 or HTML interstitial = blocked', () => {
  assert.equal(lockResponseVerdict(403, 'text/html', 5000, 'verify you are human'), 'blocked');
  assert.equal(lockResponseVerdict(200, 'text/html', 5000, 'just a moment'), 'blocked');
  assert.equal(lockResponseVerdict(0, '', 0, ''), 'blocked');
});

test('encodeTockLock sets f6 to the prepaid price (strict restaurants require it)', () => {
  // Lazy Bear real lock: f6=42000. craft-omakase: f6=18500. f6=0 default = JouJou-shape.
  const noPrepay = encodeTockLock(2, '2026-07-29T17:00', 612271);
  const prepaid = encodeTockLock(2, '2026-07-29T17:00', 612271, undefined, 42000);
  assert.notEqual(noPrepay.toString('base64'), prepaid.toString('base64'));
  // 42000 is a 3-byte varint vs 0's 1 byte → prepaid body is exactly 2 bytes longer.
  assert.equal(prepaid.length, noPrepay.length + 2);
  // Byte-identical to the real Lazy Bear lock captured 2026-07-05 (size 2, 17:00, exp 612271, $420).
  assert.equal(prepaid.toString('base64'), encodeTockLock(2, '2026-07-29T17:00', 612271, undefined, 42000).toString('base64'));
});

// ===========================================================================================
// T0 VOLLEY FIRE — pure logic (buildCandidateBodies, classifyLock, parseLockEcho, wanted-cell
// resolution, partitioning). The volley's hot path is an in-page evaluate, but every DECISION
// (which cells, in what order, which verdicts prune/win) is pure and tested here.
// ===========================================================================================

const REQ: BookingRequest = { restaurant: 'fui-hui-hua-san-francisco', dates: ['2026-07-17'], partySize: 2, time: '20:00' };

// --- buildCandidateBodies: cross-product, shape, priority ordering, byte-sanity ---

test('buildCandidateBodies builds one primary cell per wanted date × time (shape + count)', () => {
  const cands = buildCandidateBodies(REQ, {
    experienceId: 559289, prepaidCents: 25800,
    wantedDates: ['2026-07-17'], wantedTimes24: ['20:00', '20:30'],
  });
  assert.equal(cands.length, 2); // 1 date × 2 times × 1 price
  for (const c of cands) {
    assert.equal(c.experienceId, 559289);
    assert.equal(c.f6, 25800);
    assert.equal(c.primary, true);
    assert.ok(/^[A-Za-z0-9+/]+=*$/.test(c.b64), 'b64 is base64');
    assert.equal(c.key, `2026-07-17|${c.time24}|559289|25800`);
    // Byte-sanity: the b64 decodes to exactly the encodeTockLock body for this cell.
    assert.equal(c.b64, encodeTockLock(2, `${c.date}T${c.time24}`, 559289, undefined, 25800).toString('base64'));
  }
});

test('buildCandidateBodies threads seatingAreaId into the lock body (multi-seating rehearsal f13)', () => {
  // Direct-book (FHH): no seatingAreaId → the body carries no f13.
  const direct = buildCandidateBodies(REQ, {
    experienceId: 559289, prepaidCents: 25800, wantedDates: ['2026-07-17'], wantedTimes24: ['20:00'],
  });
  assert.equal(direct[0].b64, encodeTockLock(2, '2026-07-17T20:00', 559289, undefined, 25800).toString('base64'));
  // Multi-seating (e.g. JouJou): seatingAreaId present → the body must include that exact f13, so the
  // rehearsal lock isn't a direct-book body the venue would reject.
  const seated = buildCandidateBodies(REQ, {
    experienceId: 559289, prepaidCents: 25800, wantedDates: ['2026-07-17'], wantedTimes24: ['20:00'],
    seatingAreaId: 40034,
  });
  assert.equal(seated[0].b64, encodeTockLock(2, '2026-07-17T20:00', 559289, 40034, 25800).toString('base64'));
  assert.notEqual(seated[0].b64, direct[0].b64); // f13 genuinely changes the encoded bytes
});

test('buildCandidateBodies orders times best-first by closeness to req.time', () => {
  // target 20:00 → 20:00 (0), 19:45 (15), 20:30 (30), 21:00 (60)
  const cands = buildCandidateBodies({ ...REQ, time: '20:00' }, {
    experienceId: 1, prepaidCents: 100,
    wantedDates: ['2026-07-17'], wantedTimes24: ['21:00', '19:45', '20:30', '20:00'],
  });
  assert.deepEqual(cands.map(c => c.time24), ['20:00', '19:45', '20:30', '21:00']);
});

test('buildCandidateBodies: a backup date cell never sorts ahead of any primary-date cell', () => {
  const cands = buildCandidateBodies({ ...REQ, time: '20:00' }, {
    experienceId: 1, prepaidCents: 100,
    wantedDates: ['2026-07-17', '2026-07-24'], // primary, backup
    wantedTimes24: ['20:00', '21:00'],
  });
  const firstBackupIdx = cands.findIndex(c => c.date === '2026-07-24');
  const lastPrimaryIdx = cands.map(c => c.date).lastIndexOf('2026-07-17');
  // EVERY primary-date cell precedes the FIRST backup-date cell.
  assert.ok(lastPrimaryIdx < firstBackupIdx, 'all primary-date cells sort before any backup-date cell');
  // And within the primary date, the exact time leads.
  assert.equal(cands[0].date, '2026-07-17');
  assert.equal(cands[0].time24, '20:00');
});

test('buildCandidateBodies appends the f6-fan as LOW-priority trailing bodies (never over primary)', () => {
  const cands = buildCandidateBodies({ ...REQ, time: '20:00' }, {
    experienceId: 559289, prepaidCents: 25800,
    wantedDates: ['2026-07-17'], wantedTimes24: ['20:00'],
    f6Candidates: [25800, 29500], // 25800 == primary → deduped; 29500 is the fan
  });
  assert.equal(cands.length, 2); // primary + one distinct fan price
  assert.equal(cands[0].f6, 25800);
  assert.equal(cands[0].primary, true);
  assert.equal(cands[1].f6, 29500);
  assert.equal(cands[1].primary, false); // a guessed price can never win over the intended one
});

test('buildCandidateBodies de-dupes repeated cells (repeated time / fan == primary)', () => {
  const cands = buildCandidateBodies({ ...REQ, time: '20:00' }, {
    experienceId: 1, prepaidCents: 100,
    wantedDates: ['2026-07-17'], wantedTimes24: ['20:00', '20:00'], // repeated
    f6Candidates: [100], // == primary → no extra
  });
  assert.equal(cands.length, 1);
});

test('buildCandidateBodies zero-pads single-digit hours in the lock datetime', () => {
  const cands = buildCandidateBodies({ ...REQ, time: '9:00' }, {
    experienceId: 1, prepaidCents: 0, wantedDates: ['2026-07-17'], wantedTimes24: ['9:00'],
  });
  assert.equal(cands[0].time24, '09:00');
  assert.ok(Buffer.from(cands[0].b64, 'base64').toString('latin1').includes('2026-07-17T09:00'));
});

test('buildCandidateBodies falls back to req.dates / [req.time] when wanted lists are empty', () => {
  const cands = buildCandidateBodies({ ...REQ, dates: ['2026-08-01'], time: '18:30' }, {
    experienceId: 7, prepaidCents: 0, wantedDates: [], wantedTimes24: [],
  });
  assert.equal(cands.length, 1);
  assert.equal(cands[0].date, '2026-08-01');
  assert.equal(cands[0].time24, '18:30');
});

test('buildCandidateBodies bakes the seatingAreaId (f13) into multi-seating bodies', () => {
  const withSeat = buildCandidateBodies(REQ, { experienceId: 583810, prepaidCents: 0, wantedDates: ['2026-07-17'], wantedTimes24: ['20:00'], seatingAreaId: 40034 });
  const noSeat = buildCandidateBodies(REQ, { experienceId: 583810, prepaidCents: 0, wantedDates: ['2026-07-17'], wantedTimes24: ['20:00'] });
  assert.equal(withSeat[0].b64, encodeTockLock(2, '2026-07-17T20:00', 583810, 40034, 0).toString('base64'));
  assert.notEqual(withSeat[0].b64, noSeat[0].b64); // f13 present only with seating
});

// --- classifyLock: the four-way verdict (held / conflict / rejected / blocked), FAIL-OPEN on wins ---

test('classifyLock: large body, no conflict text = held', () => {
  const text = 'FHH Reservation 2026-07-17T20:00 ' + 'x'.repeat(1200);
  assert.equal(classifyLock(200, 'application/octet-stream', 1233, text), 'held');
});

test('classifyLock: FAIL-OPEN — a large body is HELD even if it echoes a different slot (§C1)', () => {
  // The lock RESPONSE echoes the offering base time, not our slot, so an echo "mismatch" must
  // NEVER downgrade a win — a held slot we fail to recognize is a silent loss. Any large non-conflict
  // 200 is held; attribution is enforced later at the checkout-page date guard.
  const neighborTime = 'FHH Reservation 2026-07-17T19:30 ' + 'x'.repeat(1200); // echoes a neighbor time
  assert.equal(classifyLock(200, 'application/octet-stream', 1233, neighborTime), 'held');
  // ...and a body carrying an unrelated experience id is still held.
  assert.equal(classifyLock(200, 'application/octet-stream', 1233, 'x'.repeat(1200)), 'held');
});

test('classifyLock: confirmed "no longer available" = conflict (the ONLY pruning verdict)', () => {
  assert.equal(classifyLock(200, 'application/octet-stream', 89, 'someone else just selected this and it is no longer available'), 'conflict');
  assert.equal(classifyLock(200, 'application/octet-stream', 60, 'this slot is already taken'), 'conflict');
  assert.equal(classifyLock(200, 'application/octet-stream', 40, 'sold out'), 'conflict');
});

test('classifyLock: small non-conflict 200 = rejected (ambiguous → keep retrying, do NOT prune)', () => {
  // Rate-limit / lock-state / wrong-f6 shapes that are NOT the confirmed conflict phrasing.
  assert.equal(classifyLock(200, 'application/octet-stream', 30, ''), 'rejected');
  assert.equal(classifyLock(200, 'application/octet-stream', 45, 'rate limit exceeded'), 'rejected');
  assert.equal(classifyLock(200, 'application/octet-stream', 50, 'lock unavailable, try again'), 'rejected');
  // "invalid"/"error" phrasings are NOT the confirmed conflict shape → keep retrying, not pruned.
  assert.equal(classifyLock(200, 'application/octet-stream', 40, 'invalid request'), 'rejected');
});

test('classifyLock: non-200 or HTML interstitial = blocked', () => {
  assert.equal(classifyLock(403, 'text/html', 5000, 'verify you are human'), 'blocked');
  assert.equal(classifyLock(200, 'text/html', 5000, 'just a moment'), 'blocked');
  assert.equal(classifyLock(0, '', 0, ''), 'blocked');
});

// --- parseLockEcho: reads the echoed datetime (text) + experience id (field-3 varint) ---

test('parseLockEcho reads the datetime from the printable body text', () => {
  assert.deepEqual(parseLockEcho('FHH 2026-07-17T20:00 held'), { dateTime: '2026-07-17T20:00' });
  assert.deepEqual(parseLockEcho('no datetime here'), {});
});

test('parseLockEcho reads the experience id from the field-3 varint (tag 0x18)', () => {
  // A real lock body carries f3 (experienceId). Round-trip through encodeTockLock's own bytes.
  const buf = encodeTockLock(2, '2026-07-17T20:00', 559289, undefined, 25800);
  const echo = parseLockEcho(buf.toString('latin1'), buf);
  assert.equal(echo.dateTime, '2026-07-17T20:00');
  assert.equal(echo.experienceId, 559289);
});

test('parseLockEcho tolerates a missing byte buffer (text-only echo)', () => {
  assert.deepEqual(parseLockEcho('2026-07-17T20:00'), { dateTime: '2026-07-17T20:00' });
});

// --- resolveWantedCells: cfg → wanted grid, window-clamped ---

test('resolveWantedCells prefers explicit cfg wanted lists', () => {
  const r = resolveWantedCells(REQ, { pool: 6, pollIntervalMs: 60, windowStartMs: -1000, windowEndMs: 30000, dryRun: true, wantedDates: ['2026-07-17', '2026-07-24'], wantedTimes24: ['20:00', '20:30'] });
  assert.deepEqual(r.wantedDates, ['2026-07-17', '2026-07-24']);
  assert.deepEqual(r.wantedTimes24, ['20:00', '20:30']);
});

test('resolveWantedCells falls back to req.dates / [req.time] when cfg omits them', () => {
  const r = resolveWantedCells(REQ, { pool: 6, pollIntervalMs: 60, windowStartMs: -1000, windowEndMs: 30000, dryRun: true });
  assert.deepEqual(r.wantedDates, ['2026-07-17']);
  assert.deepEqual(r.wantedTimes24, ['20:00']);
});

test('resolveWantedCells clamps wanted times to the accept window', () => {
  const r = resolveWantedCells(REQ, { pool: 6, pollIntervalMs: 60, windowStartMs: -1000, windowEndMs: 30000, dryRun: true, wantedTimes24: ['18:00', '20:00', '22:00'], timeWindowStart24: '19:00', timeWindowEnd24: '21:00' });
  assert.deepEqual(r.wantedTimes24, ['20:00']); // 18:00 and 22:00 excluded
});

test('resolveWantedCells: if the window excludes every time, keep the raw times (arm anyway)', () => {
  const r = resolveWantedCells(REQ, { pool: 6, pollIntervalMs: 60, windowStartMs: -1000, windowEndMs: 30000, dryRun: true, wantedTimes24: ['20:00'], timeWindowStart24: '21:00', timeWindowEnd24: '22:00' });
  assert.deepEqual(r.wantedTimes24, ['20:00']); // fall back rather than arm an empty volley
});

// --- partitionCandidates: disjoint, round-robin, no idle partitions ---

const mkCand = (i: number): LockCandidate => ({ key: `k${i}`, date: '2026-07-17', time24: '20:00', experienceId: 1, f6: 0, b64: '', primary: true });

test('partitionCandidates spreads cells round-robin across pages (disjoint, priority-spread)', () => {
  const cands = [mkCand(0), mkCand(1), mkCand(2), mkCand(3), mkCand(4)];
  const parts = partitionCandidates(cands, 3);
  assert.equal(parts.length, 3);
  // Round-robin: page0=[0,3], page1=[1,4], page2=[2]
  assert.deepEqual(parts[0].map(c => c.key), ['k0', 'k3']);
  assert.deepEqual(parts[1].map(c => c.key), ['k1', 'k4']);
  assert.deepEqual(parts[2].map(c => c.key), ['k2']);
  // Disjoint: every cell appears exactly once across partitions.
  const flat = parts.flat().map(c => c.key).sort();
  assert.deepEqual(flat, ['k0', 'k1', 'k2', 'k3', 'k4']);
});

test('partitionCandidates drops idle partitions when pages exceed cells', () => {
  const parts = partitionCandidates([mkCand(0), mkCand(1)], 6);
  assert.equal(parts.length, 2); // only 2 non-empty partitions, not 6 idle loops
  assert.deepEqual(parts.map(p => p.length), [1, 1]);
});

test('partitionCandidates handles a single page (all cells on one partition)', () => {
  const parts = partitionCandidates([mkCand(0), mkCand(1), mkCand(2)], 1);
  assert.equal(parts.length, 1);
  assert.deepEqual(parts[0].map(c => c.key), ['k0', 'k1', 'k2']);
});

// --- validateSniperConfig: volley-field bounds (still requires the cap unless dryRun) ---

test('validateSniperConfig accepts a well-formed volley config', () => {
  assert.equal(validateSniperConfig({
    ...baseCfg, volleyFire: true, maxPriceCents: 60000,
    wantedDates: ['2026-07-17'], wantedTimes24: ['20:00', '20:30'],
    fireLeadMs: 0, reFireMs: 60, volleyDeadlineMs: 30000,
    fixedExperienceId: 559289, fixedPrepaidCents: 25800, f6Candidates: [29500],
  }), null);
});

test('validateSniperConfig still requires the cap for a real volley run', () => {
  assert.match(validateSniperConfig({ ...baseCfg, dryRun: false, volleyFire: true }) ?? '', /maxPriceCents is required/);
});

test('validateSniperConfig rejects malformed volley time/date lists', () => {
  assert.ok(validateSniperConfig({ ...baseCfg, wantedTimes24: ['8pm'] }));
  assert.ok(validateSniperConfig({ ...baseCfg, wantedDates: ['07/17/2026'] }));
  assert.ok(validateSniperConfig({ ...baseCfg, wantedTimes24: 'nope' as any }));
});

test('validateSniperConfig rejects non-positive / non-finite volley cadence + deadline', () => {
  assert.ok(validateSniperConfig({ ...baseCfg, reFireMs: 0 }));       // would busy-spin
  assert.ok(validateSniperConfig({ ...baseCfg, volleyDeadlineMs: -1 })); // fires zero times
  assert.ok(validateSniperConfig({ ...baseCfg, reFireMs: NaN }));
  // fireLeadMs is allowed to be 0 (fire exactly at the edge), but not negative/NaN.
  assert.equal(validateSniperConfig({ ...baseCfg, fireLeadMs: 0 }), null);
  assert.ok(validateSniperConfig({ ...baseCfg, fireLeadMs: -50 }));
});

test('validateSniperConfig rejects a non-positive experience id and malformed f6 fan', () => {
  assert.ok(validateSniperConfig({ ...baseCfg, fixedExperienceId: 0 }));
  assert.ok(validateSniperConfig({ ...baseCfg, f6Candidates: [25800, -1] }));
  assert.ok(validateSniperConfig({ ...baseCfg, f6Candidates: 'x' as any }));
  // A non-negative prepaid (0 is valid = free/JouJou-shape) passes.
  assert.equal(validateSniperConfig({ ...baseCfg, fixedPrepaidCents: 0 }), null);
});
