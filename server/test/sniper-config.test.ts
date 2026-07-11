import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeVolleyFields } from '../src/sniper-config';

/**
 * normalizeVolleyFields is the ONE place index.ts's two sniper routes (/api/sniper,
 * /api/scheduled) coerce the untyped T0-Volley-Fire fields of an inbound request into the
 * SniperConfig subset the engine reads. These tests pin the coercion contract: pass valid
 * values through unchanged, drop malformed/absent ones to `undefined` (so nothing forces a
 * default ON), and require an exact `=== true` to arm the volley path.
 */

test('undefined payload → empty object (nothing forced on)', () => {
  assert.deepEqual(normalizeVolleyFields(undefined), {});
});

test('well-formed payload passes every field through unchanged', () => {
  const out = normalizeVolleyFields({
    volleyFire: true,
    wantedTimes24: ['20:00', '19:30'],
    wantedDates: ['2026-07-17'],
    fireLeadMs: 40,
    reFireMs: 60,
    volleyDeadlineMs: 30_000,
    fixedExperienceId: 559289,
    fixedPrepaidCents: 25800,
    fixedSeatingAreaId: 40034,
    f6Candidates: [25800, 29500],
  });
  assert.deepEqual(out, {
    volleyFire: true,
    wantedTimes24: ['20:00', '19:30'],
    wantedDates: ['2026-07-17'],
    fireLeadMs: 40,
    reFireMs: 60,
    volleyDeadlineMs: 30_000,
    fixedExperienceId: 559289,
    fixedPrepaidCents: 25800,
    fixedSeatingAreaId: 40034,
    f6Candidates: [25800, 29500],
  });
});

test('volleyFire arms ONLY on exact true — truthy non-booleans do not', () => {
  assert.equal(normalizeVolleyFields({ volleyFire: true }).volleyFire, true);
  // Every non-`true` value must read as "not armed" (undefined), never silently engage the
  // volley path off a stray "true" string / 1 / {} that a loose client might send.
  for (const v of ['true', 1, {}, [], 'yes', false, 0, null]) {
    assert.equal(normalizeVolleyFields({ volleyFire: v }).volleyFire, undefined, `value ${JSON.stringify(v)}`);
  }
});

test('fireLeadMs=0 is preserved (fire exactly at the edge is a real value, not absent)', () => {
  // 0 is meaningful (validateSniperConfig allows fireLeadMs >= 0), so it must NOT collapse to
  // undefined the way an empty list does — a numeric 0 is a deliberate "no send lead".
  assert.equal(normalizeVolleyFields({ fireLeadMs: 0 }).fireLeadMs, 0);
  assert.equal(normalizeVolleyFields({ fixedPrepaidCents: 0 }).fixedPrepaidCents, 0);
});

test('non-finite numbers drop to undefined (NaN/Infinity never reach the engine)', () => {
  for (const bad of [NaN, Infinity, -Infinity, '40', null, {}]) {
    assert.equal(normalizeVolleyFields({ fireLeadMs: bad }).fireLeadMs, undefined, `fireLeadMs ${JSON.stringify(bad)}`);
    assert.equal(normalizeVolleyFields({ reFireMs: bad }).reFireMs, undefined, `reFireMs ${JSON.stringify(bad)}`);
    assert.equal(normalizeVolleyFields({ fixedExperienceId: bad }).fixedExperienceId, undefined, `fixedExperienceId ${JSON.stringify(bad)}`);
  }
});

test('empty arrays read as absent (undefined), not as "want nothing"', () => {
  const out = normalizeVolleyFields({ wantedTimes24: [], wantedDates: [], f6Candidates: [] });
  assert.equal(out.wantedTimes24, undefined);
  assert.equal(out.wantedDates, undefined);
  assert.equal(out.f6Candidates, undefined);
});

test('mistyped arrays drop to undefined (no partial/heterogeneous leak-through)', () => {
  // A string list with a number in it, or a non-array, must not pass a half-valid value to
  // the engine — the whole field drops so validateSniperConfig never sees a malformed element.
  assert.equal(normalizeVolleyFields({ wantedTimes24: ['20:00', 1930] }).wantedTimes24, undefined);
  assert.equal(normalizeVolleyFields({ wantedDates: 'not-an-array' }).wantedDates, undefined);
  assert.equal(normalizeVolleyFields({ f6Candidates: [25800, '29500'] }).f6Candidates, undefined);
  assert.equal(normalizeVolleyFields({ f6Candidates: [25800, NaN] }).f6Candidates, undefined);
});

test('partial payload only carries the fields actually present', () => {
  const out = normalizeVolleyFields({ volleyFire: true, wantedTimes24: ['20:00'] });
  assert.deepEqual(out, {
    volleyFire: true,
    wantedTimes24: ['20:00'],
    wantedDates: undefined,
    fireLeadMs: undefined,
    reFireMs: undefined,
    volleyDeadlineMs: undefined,
    fixedExperienceId: undefined,
    fixedPrepaidCents: undefined,
    fixedSeatingAreaId: undefined,
    f6Candidates: undefined,
  });
});
