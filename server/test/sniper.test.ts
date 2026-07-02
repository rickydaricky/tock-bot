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
} from '../src/sniper';

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
