import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  freezeSession,
  listSessions,
  getSession,
  abortSession,
  applyAction,
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

test('_sweep leaves an un-expired session open (strict ttl boundary)', async () => {
  let now = 0; _setNow(() => now);
  const { handle, state } = fakeHandle();
  const id = freezeSession({ handle: handle as any, restaurant: 'x', ttlMs: 1000 });
  now = 1000; // age == ttl, NOT past it
  _sweep();
  await new Promise(r => setTimeout(r, 5));
  assert.equal(state.closed, false);
  assert.equal(getSession(id) !== undefined, true);
});

test('abortSession returns false for an unknown id', async () => {
  assert.equal(await abortSession('does-not-exist'), false);
});

test('abortSession drops the entry even if close() throws', async () => {
  const handle = { browser: { close: async () => { throw new Error('boom'); } }, page: {} };
  const id = freezeSession({ handle: handle as any, restaurant: 'x' });
  assert.equal(await abortSession(id), true);   // error swallowed
  assert.equal(getSession(id), undefined);      // no zombie entry
});

test('applyAction: missing session and unknown action return clear errors', async () => {
  assert.deepEqual(await applyAction('nope', 'abort'), { ok: false, error: 'session not found' });
  const { handle } = fakeHandle();
  const id = freezeSession({ handle: handle as any, restaurant: 'x' });
  assert.deepEqual(await applyAction(id, 'bogus' as any), { ok: false, error: 'unknown action: bogus' });
});

test('freezeSession stores maxPriceCents so retry-purchase can fail-close on the cap', () => {
  const { handle } = fakeHandle();
  // The manual retry path reads e.maxPriceCents and threads it into
  // handlePurchaseFlow(page, false, [], cap); storing it here is the whole
  // fix — without it, a human-triggered retry spends uncapped.
  const id = freezeSession({ handle: handle as any, restaurant: 'fhh', maxPriceCents: 51600 });
  assert.equal(getSession(id)?.maxPriceCents, 51600);
});

test('freezeSession without a cap stores undefined (dry-run origin, no-cap semantics preserved)', () => {
  const { handle } = fakeHandle();
  const id = freezeSession({ handle: handle as any, restaurant: 'fhh' });
  assert.equal(getSession(id)?.maxPriceCents, undefined);
});

test('guessedPriceCents is stored and surfaced on the public session for the dashboard banner', () => {
  const { handle } = fakeHandle();
  const id = freezeSession({ handle: handle as any, restaurant: 'fhh', maxPriceCents: 59000, guessedPriceCents: 29500 });
  // Not leaked to the public view? It must be, so the RED banner can render.
  const pub = listSessions().find(e => e.id === id)!;
  assert.equal(pub.guessedPriceCents, 29500);
  // And the internal record keeps it too.
  assert.equal(getSession(id)?.guessedPriceCents, 29500);
});

test('public session omits guessedPriceCents when the price was not guessed', () => {
  const { handle } = fakeHandle();
  const id = freezeSession({ handle: handle as any, restaurant: 'fhh', maxPriceCents: 51600 });
  const pub = listSessions().find(e => e.id === id)!;
  assert.equal(pub.guessedPriceCents, undefined); // no banner for the known-price path
});

test('applyAction: refresh-screenshot is a no-op ok; abort closes + drops', async () => {
  const { handle, state } = fakeHandle();
  const id = freezeSession({ handle: handle as any, restaurant: 'x' });
  assert.deepEqual(await applyAction(id, 'refresh-screenshot'), { ok: true });
  assert.equal(getSession(id) !== undefined, true); // still alive
  assert.deepEqual(await applyAction(id, 'abort'), { ok: true });
  assert.equal(state.closed, true);
  assert.equal(getSession(id), undefined);
});
