import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseAvailability, pickBestSlot, SingleWinnerLock } from '../src/sniper';
import { freezeSession, listSessions, abortSession, _reset, _setNow } from '../src/sessions';

// Detect → single-winner grab, over a feed that flips none→slot mid-flight.
test('concurrent poll loops over a none→slot feed yield exactly one winner', async () => {
  let flipped = false;
  // Mirrors Tock's real calendar.offerings model: none → an AVAILABLE slot mid-window.
  const feed = () => flipped
    ? { openDate: ['2026-07-01'], openTime: ['20:00'], experience: [{ id: 'win', state: 'AVAILABLE', partySize: [2] }] }
    : { openDate: [], openTime: [], experience: [] };
  setTimeout(() => { flipped = true; }, 50);

  const lock = new SingleWinnerLock();
  const winners: string[] = [];
  async function loop() {
    for (let i = 0; i < 80; i++) {
      const slot = pickBestSlot(parseAvailability(feed(), 2), ['2026-07-01'], '20:00');
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
