import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseAvailability, pickSlot, SingleWinnerLock } from '../src/sniper';
import { freezeSession, listSessions, abortSession, _reset, _setNow } from '../src/sessions';

// Detect → single-winner grab, over a feed that flips none→slot mid-flight.
test('concurrent poll loops over a none→slot feed yield exactly one winner', async () => {
  let flipped = false;
  const feed = () => flipped
    ? { availability: [{ date: '2026-07-01', offers: [{ time: '8:00 PM', id: 'win' }] }] }
    : { availability: [] };
  setTimeout(() => { flipped = true; }, 50);

  const lock = new SingleWinnerLock();
  const winners: string[] = [];
  async function loop() {
    for (let i = 0; i < 80; i++) {
      const slot = pickSlot(parseAvailability(feed()), '2026-07-01', '20:00');
      if (slot && lock.tryAcquire()) { winners.push(slot.offerId!); return; }
      await new Promise(r => setTimeout(r, 10));
    }
  }
  await Promise.all([loop(), loop(), loop(), loop(), loop()]);

  assert.equal(winners.length, 1);
  assert.equal(winners[0], 'win');
});

// Purchase-failure path: freeze a recoverable session, then abort it.
test('purchase-failure path freezes a recoverable session', async () => {
  _reset(); _setNow(() => 0);
  let closed = false;
  const handle = { browser: { close: async () => { closed = true; } }, page: {} };
  const id = freezeSession({ handle: handle as any, restaurant: 'fhh', bookedDate: '2026-07-01', bookedTime: '8:00 PM', error: 'purchase failed' });
  assert.equal(listSessions().some(s => s.id === id), true);
  assert.equal(await abortSession(id), true);
  assert.equal(closed, true);
});
