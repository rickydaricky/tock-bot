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

// parseAvailability operates on Tock's real `calendar.offerings` model (confirmed
// by live recon): openDate[] × openTime[] (24h) for AVAILABLE experiences matching size.

test('parseAvailability builds slots from openDate × openTime for an AVAILABLE matching experience', () => {
  const offerings = {
    openDate: ['2026-07-22'],
    openTime: ['17:00', '19:00'],
    experience: [{ id: 612271, state: 'AVAILABLE', partySize: [2, 3] }],
  };
  assert.deepEqual(parseAvailability(offerings, 2), [
    { date: '2026-07-22', time12: '5:00 PM', offerId: '612271' },
    { date: '2026-07-22', time12: '7:00 PM', offerId: '612271' },
  ]);
});

test('parseAvailability returns [] when no AVAILABLE experience matches the party size', () => {
  const offerings = {
    openDate: ['2026-07-22'],
    openTime: ['19:00'],
    experience: [
      { id: 1, state: 'SOLD', partySize: [2] },         // sold out
      { id: 2, state: 'AVAILABLE', partySize: [4, 5] },  // wrong size
    ],
  };
  assert.deepEqual(parseAvailability(offerings, 2), []);
});

test('parseAvailability picks the first AVAILABLE matching experience id', () => {
  const offerings = {
    openDate: ['2026-07-01'],
    openTime: ['20:00'],
    experience: [
      { id: 'a', state: 'AVAILABLE', partySize: [2] },
      { id: 'b', state: 'AVAILABLE', partySize: [2] },
    ],
  };
  assert.deepEqual(parseAvailability(offerings, 2), [{ date: '2026-07-01', time12: '8:00 PM', offerId: 'a' }]);
});

test('parseAvailability converts noon/midnight/12:30 openTimes correctly (24h→12h)', () => {
  const offerings = {
    openDate: ['2026-07-22'],
    openTime: ['00:00', '12:00', '12:30'],
    experience: [{ id: 5, state: 'AVAILABLE', partySize: [2] }],
  };
  assert.deepEqual(parseAvailability(offerings, 2), [
    { date: '2026-07-22', time12: '12:00 AM', offerId: '5' },
    { date: '2026-07-22', time12: '12:00 PM', offerId: '5' },
    { date: '2026-07-22', time12: '12:30 PM', offerId: '5' },
  ]);
});

test('parseAvailability emits the full date × time cross-product (dates outer)', () => {
  const offerings = {
    openDate: ['2026-07-22', '2026-07-23'],
    openTime: ['17:00', '19:00'],
    experience: [{ id: 9, state: 'AVAILABLE', partySize: [2] }],
  };
  assert.deepEqual(parseAvailability(offerings, 2), [
    { date: '2026-07-22', time12: '5:00 PM', offerId: '9' },
    { date: '2026-07-22', time12: '7:00 PM', offerId: '9' },
    { date: '2026-07-23', time12: '5:00 PM', offerId: '9' },
    { date: '2026-07-23', time12: '7:00 PM', offerId: '9' },
  ]);
});

test('parseAvailability skips experiences missing partySize without throwing', () => {
  const offerings = {
    openDate: ['2026-07-22'],
    openTime: ['19:00'],
    experience: [
      { id: 1, state: 'AVAILABLE' },                 // partySize undefined → skipped
      { id: 2, state: 'AVAILABLE', partySize: [2] },
    ],
  };
  assert.deepEqual(parseAvailability(offerings, 2), [{ date: '2026-07-22', time12: '7:00 PM', offerId: '2' }]);
});

test('parseAvailability excludes experiences whose state is not exactly AVAILABLE', () => {
  const offerings = {
    openDate: ['2026-07-22'],
    openTime: ['19:00'],
    experience: [
      { id: 1, state: 'WAITLIST', partySize: [2] },
      { id: 2, state: undefined as any, partySize: [2] },
      { id: 3, state: 'available', partySize: [2] }, // wrong case
    ],
  };
  assert.deepEqual(parseAvailability(offerings, 2), []);
});

test('parseAvailability tolerates null and empty offerings', () => {
  assert.deepEqual(parseAvailability(null, 2), []);
  assert.deepEqual(parseAvailability({ openDate: [], openTime: [], experience: [] }, 2), []);
});
