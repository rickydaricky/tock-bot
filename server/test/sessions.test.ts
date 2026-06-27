import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  freezeSession,
  listSessions,
  getSession,
  abortSession,
  _setNow,
  _sweep,
  _reset,
} from '../src/sessions';

function fakeHandle() {
  const state = { closed: false };
  return {
    handle: { browser: { close: async () => { state.closed = true; } }, page: {} },
    state,
  };
}

beforeEach(() => { _reset(); _setNow(() => 0); });

test('freeze + list + get with deterministic age', () => {
  let now = 1000; _setNow(() => now);
  const { handle } = fakeHandle();
  const id = freezeSession({ handle: handle as any, restaurant: 'fhh', bookedDate: '2026-07-01', bookedTime: '8:00 PM', error: 'purchase failed' });
  now = 4000;
  const entry = listSessions().find(e => e.id === id)!;
  assert.equal(entry.restaurant, 'fhh');
  assert.equal(entry.ageMs, 3000);
  assert.equal(getSession(id)?.error, 'purchase failed');
});

test('abort closes browser and removes from registry', async () => {
  const { handle, state } = fakeHandle();
  const id = freezeSession({ handle: handle as any, restaurant: 'x' });
  assert.equal(await abortSession(id), true);
  assert.equal(state.closed, true);
  assert.equal(getSession(id), undefined);
});

test('_sweep closes sessions past their ttl', async () => {
  let now = 0; _setNow(() => now);
  const { handle, state } = fakeHandle();
  freezeSession({ handle: handle as any, restaurant: 'x', ttlMs: 1000 });
  now = 2000;
  _sweep();
  await new Promise(r => setTimeout(r, 5)); // let the async close settle
  assert.equal(listSessions().length, 0);
  assert.equal(state.closed, true);
});
