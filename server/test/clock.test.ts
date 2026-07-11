import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseDateHeaderMs,
  computeCalibration,
  computeFireAt,
  t0Epoch,
  t0Local,
  type ClockSample,
} from '../src/clock';

// ── parseDateHeaderMs: RFC 7231 IMF-fixdate, always whole-second, null on garbage ──────────

test('parseDateHeaderMs parses a real Tock-style Date header to a whole-second epoch', () => {
  const ms = parseDateHeaderMs('Fri, 11 Jul 2026 03:00:00 GMT');
  assert.equal(ms, Date.UTC(2026, 6, 11, 3, 0, 0));
  assert.equal(ms! % 1000, 0, 'header is 1s-resolution → epoch is a whole second');
});

test('parseDateHeaderMs returns null for missing/empty/garbage headers (drop the sample)', () => {
  assert.equal(parseDateHeaderMs(null), null);
  assert.equal(parseDateHeaderMs(undefined), null);
  assert.equal(parseDateHeaderMs(''), null);
  assert.equal(parseDateHeaderMs('not a date'), null);
});

// ── computeCalibration: second-rollover pins the phase; else fall back to tightest sample ───

// Build a sample as if the server clock == our clock + `offsetMs`, with a symmetric RTT.
// The `date` header the server would emit is floor((midEpoch + offsetMs)/1000)*1000.
function sampleAt(ourMidEpoch: number, offsetMs: number, rttMs: number): ClockSample {
  const serverNow = ourMidEpoch + offsetMs;
  const serverSecMs = Math.floor(serverNow / 1000) * 1000;
  return {
    serverSecMs,
    t0: ourMidEpoch - rttMs / 2,
    t1: ourMidEpoch + rttMs / 2,
    midMs: ourMidEpoch,
    rttMs,
  };
}

test('computeCalibration pins the offset from a second-rollover to well within ±150ms', () => {
  // Truth: server is +37ms ahead of us. Spin samples 120ms apart across a server-second tick.
  const trueOffset = 37;
  // Choose a base so a rollover falls mid-run: server second ticks at our-epoch ≈ 963ms.
  const base = 10_000_000_000 - trueOffset; // so serverNow crosses a whole second near base+963
  const mids = [base + 800, base + 920, base + 1040, base + 1160, base + 1280, base + 1400];
  const samples = mids.map(m => sampleAt(m, trueOffset, 40));

  const cal = computeCalibration(samples);
  // The estimated offset should recover the truth to within the confidence bracket.
  assert.ok(Math.abs(cal.offsetMs - trueOffset) <= cal.confidenceMs,
    `offset ${cal.offsetMs} should be within ±${cal.confidenceMs} of ${trueOffset}`);
  // A rollover with 120ms-spaced samples brackets the tick tightly (half-gap 60ms + rtt/2).
  assert.ok(cal.confidenceMs < 150, `rollover confidence ${cal.confidenceMs} should beat ±150ms`);
  assert.equal(cal.minRttMs, 40);
});

test('computeCalibration keeps the MIN rtt across samples as the uncongested floor', () => {
  const base = 5_000_000_000;
  const samples = [
    sampleAt(base + 700, 12, 90),
    sampleAt(base + 900, 12, 25),   // tightest — this rtt is the floor
    sampleAt(base + 1100, 12, 140), // crosses the second boundary vs the prior sample
  ];
  const cal = computeCalibration(samples);
  assert.equal(cal.minRttMs, 25);
});

test('computeCalibration falls back to the tightest single sample when no rollover is seen', () => {
  // All three samples land inside ONE server-second (no +1000ms tick between neighbors).
  const trueOffset = -50;
  const base = 7_000_000_100; // mid-second, so 3 close samples stay in the same second
  const samples = [
    sampleAt(base + 0, trueOffset, 80),
    sampleAt(base + 60, trueOffset, 30),  // tightest
    sampleAt(base + 120, trueOffset, 100),
  ];
  const cal = computeCalibration(samples);
  // No rollover ⇒ whole-second ambiguity ⇒ confidence ~±500ms (plus half the min rtt).
  assert.ok(cal.confidenceMs >= 500, `no-rollover confidence ${cal.confidenceMs} should be ≥500ms`);
  assert.equal(cal.minRttMs, 30);
  // Still within its (wide) bracket of the truth.
  assert.ok(Math.abs(cal.offsetMs - trueOffset) <= cal.confidenceMs);
});

test('computeCalibration fails closed (Infinity confidence) with no samples', () => {
  const cal = computeCalibration([]);
  assert.equal(cal.confidenceMs, Number.POSITIVE_INFINITY);
  assert.equal(cal.minRttMs, Number.POSITIVE_INFINITY);
  assert.equal(cal.offsetMs, 0);
});

// ── computeFireAt: pure send-lead math (fire early so the PUT ARRIVES at the edge) ──────────

test('computeFireAt subtracts rtt + lead so the PUT arrives at the edge', () => {
  const edge = 1_800_000_000_000;
  assert.equal(computeFireAt(edge, 40, 120), edge - 40 - 120);
  assert.equal(computeFireAt(edge, 0, 0), edge);
});

test('computeFireAt treats a non-finite rtt/lead as zero (uncalibrated must not fire in the past)', () => {
  const edge = 1_800_000_000_000;
  assert.equal(computeFireAt(edge, Number.POSITIVE_INFINITY, 100), edge - 100);
  assert.equal(computeFireAt(edge, 40, Number.POSITIVE_INFINITY), edge - 40);
});

// ── t0Epoch: zoned ISO is unambiguous; bare wall-time is Pacific, DST-correct ────────────────

test('t0Epoch parses a zoned (Z) ISO as-is', () => {
  assert.equal(t0Epoch('2026-07-11T03:00:00Z'), Date.UTC(2026, 6, 11, 3, 0, 0));
});

test('t0Epoch parses an explicit numeric offset', () => {
  // 20:00 at -07:00 == 03:00Z next... no, same day 03:00Z? 20:00-07:00 = 03:00Z next day.
  assert.equal(t0Epoch('2026-07-11T20:00:00-07:00'), Date.UTC(2026, 6, 12, 3, 0, 0));
});

test('t0Epoch treats a bare wall-time as America/Los_Angeles — PDT (summer, -07:00)', () => {
  // FHH drops Fri 2026-07-17 8:00 PM PDT → 03:00Z the next day (07-18).
  assert.equal(t0Epoch('2026-07-17T20:00'), Date.UTC(2026, 6, 18, 3, 0, 0));
  assert.equal(t0Epoch('2026-07-17T20:00:00'), Date.UTC(2026, 6, 18, 3, 0, 0));
});

test('t0Epoch is DST-correct — PST (winter, -08:00) is a different UTC instant than PDT', () => {
  // Same wall-time 8pm in January is PST (-08:00) → 04:00Z the next day, an hour later in UTC
  // than the summer PDT case. A hardcoded offset would get exactly one of these wrong.
  assert.equal(t0Epoch('2026-01-16T20:00'), Date.UTC(2026, 0, 17, 4, 0, 0));
  // The one-hour DST difference is real and measurable:
  const summer = t0Epoch('2026-07-16T20:00');
  const winter = t0Epoch('2026-01-16T20:00');
  const summerMidnight = Date.UTC(2026, 6, 17, 0, 0, 0);
  const winterMidnight = Date.UTC(2026, 0, 17, 0, 0, 0);
  assert.equal(winter - winterMidnight - (summer - summerMidnight), 3600_000);
});

test('t0Epoch handles the JouJou rehearsal wall-time (10:00 AM PDT)', () => {
  // 10:00 PDT (-07:00) → 17:00Z same day.
  assert.equal(t0Epoch('2026-07-11T10:00'), Date.UTC(2026, 6, 11, 17, 0, 0));
});

test('t0Epoch throws loudly on an unparseable drop time (fail at arm, never fire wrong)', () => {
  assert.throws(() => t0Epoch('tomorrow at eight'), /unrecognized drop time/);
  assert.throws(() => t0Epoch('2026-13-99T99:99'), /unrecognized drop time/);
  assert.throws(() => t0Epoch('garbageZ'), /unparseable zoned drop time/);
});

// ── t0Local: drop instant in OUR clock's timebase (server T0 − offset) ───────────────────────

test('t0Local shifts the epoch by the measured clock offset', () => {
  const iso = '2026-07-17T20:00'; // 03:00Z on 07-18
  const t0 = Date.UTC(2026, 6, 18, 3, 0, 0);
  assert.equal(t0Local(iso, 0), t0);
  // If the server is +37ms ahead of us, the drop reads 37ms EARLIER on our clock.
  assert.equal(t0Local(iso, 37), t0 - 37);
  assert.equal(t0Local(iso), t0); // default offset 0
});
