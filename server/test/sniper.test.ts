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
const baseCfg: SniperConfig = { pool: 5, pollIntervalMs: 200, windowStartMs: -1000, windowEndMs: 10000 };

test('validateSniperConfig accepts a clean config (with and without a cap)', () => {
  assert.equal(validateSniperConfig(baseCfg), null);
  assert.equal(validateSniperConfig({ ...baseCfg, maxPriceCents: 50000, timeWindowStart24: '18:00', timeWindowEnd24: '20:00' }), null);
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
