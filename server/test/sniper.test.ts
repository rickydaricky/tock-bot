import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  pickSlot,
  SingleWinnerLock,
  computeWindowOffsets,
  parseAvailability,
} from '../src/sniper';

// --- pickSlot (exact date+time matcher) ---

const slots = [
  { date: '2026-07-15', time12: '5:00 PM', offerId: 'a' },
  { date: '2026-07-15', time12: '7:00 PM', offerId: 'b' },
];

test('pickSlot exact match on date+time', () => {
  const m = pickSlot(slots, '2026-07-15', '19:00');
  assert.equal(m?.offerId, 'b');
});

test('pickSlot returns null when date absent', () => {
  assert.equal(pickSlot(slots, '2026-07-16', '19:00'), null);
});

test('pickSlot returns null when time absent (no fuzzy fallback)', () => {
  assert.equal(pickSlot(slots, '2026-07-15', '20:00'), null);
});

test('pickSlot matches case-insensitively on the slot time', () => {
  const m = pickSlot([{ date: '2026-07-15', time12: '8:00 pm', offerId: 'b' }], '2026-07-15', '20:00');
  assert.equal(m?.offerId, 'b');
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
  const o = computeWindowOffsets(5, -1000, 10000);
  assert.equal(o.length, 5);
  assert.equal(o[0], -1000);
  assert.equal(o[4], 10000);
  assert.deepEqual(o, [-1000, 1750, 4500, 7250, 10000]);
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

// --- parseAvailability (recon-seeded, isolated) ---

test('parseAvailability normalizes availability entries', () => {
  const sample = {
    availability: [
      { date: '2026-07-01', offers: [
        { time: '8:00 PM', id: 'offer-1' },
        { time: '8:15 PM', id: 'offer-2' },
      ] },
    ],
  };
  const out = parseAvailability(sample);
  assert.deepEqual(out, [
    { date: '2026-07-01', time12: '8:00 PM', offerId: 'offer-1' },
    { date: '2026-07-01', time12: '8:15 PM', offerId: 'offer-2' },
  ]);
});

test('parseAvailability normalizes the days/times/display/businessDate shape', () => {
  const out = parseAvailability({
    days: [{ businessDate: '2026-07-02', times: [{ display: '6:30 PM', offerId: 'x9' }] }],
  });
  assert.deepEqual(out, [{ date: '2026-07-02', time12: '6:30 PM', offerId: 'x9' }]);
});

test('parseAvailability drops entries missing date or time, tolerates null', () => {
  assert.deepEqual(parseAvailability(null), []);
  const out = parseAvailability({
    availability: [{ date: '2026-07-01', offers: [{ time: '8:00 PM', id: 'ok' }, { id: 'no-time' }] }],
  });
  assert.deepEqual(out, [{ date: '2026-07-01', time12: '8:00 PM', offerId: 'ok' }]);
});

test('parseAvailability returns [] on unknown shape', () => {
  assert.deepEqual(parseAvailability({ weird: true }), []);
});
