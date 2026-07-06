import { test } from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { parseSlots, pickBestSlot } from './availability';

const RAW = [
  { testid: 'time-slot-0', text: '5:30 PM' },
  { testid: 'time-slot-1', text: '6:00 PM*' },   // '*' = requires card / special
  { testid: 'time-slot-2', text: '7:15 PM' },
];

test('parseSlots normalizes 12h text to 24h and strips markers', () => {
  const slots = parseSlots(RAW);
  assert.equal(slots.length, 3);
  assert.deepEqual(slots.map(s => s.time24), ['17:30', '18:00', '19:15']);
});

test('pickBestSlot returns exact match', () => {
  const slots = parseSlots(RAW);
  assert.equal(pickBestSlot(slots, '18:00')?.testid, 'time-slot-1');
});

test('pickBestSlot returns closest when no exact match', () => {
  const slots = parseSlots(RAW);
  assert.equal(pickBestSlot(slots, '19:00')?.testid, 'time-slot-2'); // 19:15 is closest
});

test('pickBestSlot returns null for empty', () => {
  assert.equal(pickBestSlot([], '19:00'), null);
});

test('regex matches real slot text found in opentable-nopa.html', () => {
  const html = readFileSync(path.join(__dirname, '../../../opentable-nopa.html'), 'utf-8');
  // Real OpenTable slot labels look like "6:00 PM" / "6:00 PM*"; assert at least one is present
  // and parses. (The capture is a profile page snapshot.)
  const matches = html.match(/\d{1,2}:\d{2}\s*(AM|PM)/gi) || [];
  assert.ok(matches.length > 0, 'expected at least one time label in the capture');
  const parsed = parseSlots(matches.slice(0, 5).map((t, i) => ({ testid: `time-slot-${i}`, text: t })));
  assert.ok(parsed.length > 0);
});
