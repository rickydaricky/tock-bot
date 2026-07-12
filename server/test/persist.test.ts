import { test } from 'node:test';
import assert from 'node:assert/strict';
import { reloadAction } from '../src/scheduler';

// The reload decision table (§design) — the FHH-critical part: a job armed days ahead must re-arm
// after a redeploy, a just-missed job (deploy straddled the drop) must still fire, and a
// long-missed/interrupted job must NOT silently fire stale.
const NOW = Date.parse('2026-07-17T20:00:00-07:00'); // an FHH-like drop instant
const GRACE = 10 * 60_000;

test('reloadAction: future runAt → rearm (the core: FHH armed days out survives a redeploy)', () => {
  assert.equal(reloadAction(NOW + 5 * 24 * 3600_000, undefined, NOW), 'rearm');
  assert.equal(reloadAction(NOW + 60_000, undefined, NOW), 'rearm');
});

test('reloadAction: just-missed within grace → fire-now (deploy/crash straddled the drop)', () => {
  assert.equal(reloadAction(NOW - 30_000, undefined, NOW), 'fire-now');       // 30s late
  assert.equal(reloadAction(NOW - GRACE, undefined, NOW), 'fire-now');        // exactly 10min → inclusive
});

test('reloadAction: long-missed past grace → skip-missed (stale; record + notify, never silent)', () => {
  assert.equal(reloadAction(NOW - GRACE - 1000, undefined, NOW), 'skip-missed');
  assert.equal(reloadAction(NOW - 6 * 3600_000, undefined, NOW), 'skip-missed');
});

test('reloadAction: firedAt + within grace → resume-interrupted (re-fire an interrupted run)', () => {
  assert.equal(reloadAction(NOW - 60_000, new Date(NOW).toISOString(), NOW), 'resume-interrupted');
});

test('reloadAction: firedAt + past grace → skip-unknown (possible partial charge → human-check)', () => {
  assert.equal(reloadAction(NOW - 40 * 60_000, new Date(NOW).toISOString(), NOW), 'skip-unknown');
  // firedAt dominates the future-branch too: a marked job in the future is still "interrupted".
  assert.equal(reloadAction(NOW + 60_000, new Date(NOW).toISOString(), NOW), 'resume-interrupted');
});
