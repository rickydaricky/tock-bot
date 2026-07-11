/**
 * clock.ts — coarse clock-sync + fire-timing math for the T0 Volley Fire engine.
 *
 * The grab is a race: we must fire the pre-built lock PUT so it ARRIVES at Tock's origin at
 * the drop instant (T0), not one poll-cycle late. That needs two things this module owns:
 *
 *   1. A coarse estimate of how far our process clock is from Tock's server clock, plus a
 *      floor on the network round-trip — so we know how EARLY to send. `calibrateClock(page)`
 *      derives both from the origin's 1s-resolution `Date` response header by spinning
 *      in-page GETs across a second boundary (the instant the header ticks pins the server's
 *      second-phase to ~±150–300ms) and bracketing each with `performance.now()` to bound RTT.
 *
 *   2. The epoch-ms of the drop instant itself. `t0Epoch(dropIso)` resolves an ISO drop time
 *      to a UTC epoch — DST-correct via `Intl` for America/Los_Angeles when the ISO carries no
 *      zone (a bare wall-time like "2026-07-11T20:00" is 8pm *Pacific*, PDT or PST depending on
 *      the date; a recent "Fix timezone handling" bug proved hardcoded offsets are unsafe).
 *
 * The clock is COARSE by design (see spec §2): we do NOT bet the win on Date-header precision.
 * The authoritative T0 is the observed offerings-populate edge (watchPopulateEdge, sniper.ts);
 * this module bounds the ±500ms window we start covering from, and `computeFireAt` decides the
 * send-lead so an early PUT (which just retries) hides the RTT, and we never fire late.
 *
 * Exports: calibrateClock (network, in-page), t0Epoch / t0Local (pure TZ math), computeFireAt
 * (pure send-lead math), and parseDateHeaderMs (pure, unit-tested Date-header parser).
 */
import { Page } from 'playwright';

/** Result of a coarse calibration against Tock's origin clock.
 *  - offsetMs:      serverClock − ourClock at the moment we sampled. Add to Date.now() to get
 *                   Tock's current wall-time estimate. Signed; may be small.
 *  - confidenceMs:  our ± uncertainty on offsetMs. Callers HARD-GATE arming when this is worse
 *                   than ±500ms (spec §2): a bad clock means we can't even bound the window.
 *  - minRttMs:      the smallest observed round-trip across all samples — the uncongested floor
 *                   used as the pre-fire send-lead so the PUT arrives at, not after, the edge. */
export interface ClockCalibration {
  offsetMs: number;
  confidenceMs: number;
  minRttMs: number;
}

/** One bracketed Date-header sample: the server second (epoch-ms, floored to 1s as the header
 *  only carries 1s resolution) and the process-clock window [t0,t1] (performance.now() ms) that
 *  straddled the response. midMs is our best single-point estimate of when the server emitted it;
 *  rttMs bounds the round-trip. Kept as a plain shape so the phase math is pure + unit-testable. */
export interface ClockSample {
  serverSecMs: number; // Date.parse of the `date` header (always a whole second)
  t0: number;          // performance.now() immediately BEFORE the request
  t1: number;          // performance.now() immediately AFTER the response headers arrived
  midMs: number;       // (t0+t1)/2 — process-clock midpoint of the exchange
  rttMs: number;       // t1−t0 — round-trip bound for this sample
}

/**
 * Parse an HTTP `Date` header (RFC 7231 IMF-fixdate, e.g. "Fri, 11 Jul 2026 03:00:00 GMT")
 * into epoch-ms. PURE. Returns null for a missing/unparseable header rather than NaN so callers
 * can drop a bad sample instead of poisoning the offset math. The header is always a whole
 * second (1s resolution), so the returned value is a multiple of 1000.
 */
export function parseDateHeaderMs(dateHeader: string | null | undefined): number | null {
  if (!dateHeader) return null;
  const ms = Date.parse(dateHeader);
  return Number.isFinite(ms) ? ms : null;
}

/**
 * Compute the coarse server/process clock offset + RTT floor from a set of bracketed samples.
 * PURE (no network) so it is exhaustively unit-testable; `calibrateClock` just gathers the
 * samples and delegates here.
 *
 * How the phase is pinned: each Date header is a whole second S, emitted at some real instant in
 * [S, S+1000). Our process-clock estimate of that emission is the exchange midpoint `midMs`, so a
 * single sample says offset ≈ S − midMs with a ±(500 + rtt/2) error. Across many samples we keep
 * the one whose RTT is smallest (least jitter ⇒ tightest bracket) as the point estimate, and —
 * crucially — we look for a SECOND-ROLLOVER: two samples whose `serverSecMs` differ by exactly
 * one second let us bound the true tick instant to the gap between them, collapsing the ±500ms
 * whole-second ambiguity down to roughly half that gap. minRttMs is the min over all samples.
 */
export function computeCalibration(samples: ClockSample[]): ClockCalibration {
  if (samples.length === 0) {
    // No usable samples ⇒ zero offset but WORST confidence, so the arm hard-gate fails closed.
    return { offsetMs: 0, confidenceMs: Number.POSITIVE_INFINITY, minRttMs: Number.POSITIVE_INFINITY };
  }

  const minRttMs = Math.min(...samples.map(s => s.rttMs));

  // Detect a second-rollover: an adjacent pair (by process-clock midpoint) whose server-second
  // ticks by exactly +1000ms. The real tick happened between the earlier sample's response and
  // the later sample's request, so the tick instant is bracketed by their process-clock window.
  const byMid = [...samples].sort((a, b) => a.midMs - b.midMs);
  let best: { tickServerMs: number; tickMidMs: number; halfGapMs: number } | null = null;
  for (let i = 1; i < byMid.length; i++) {
    const prev = byMid[i - 1];
    const cur = byMid[i];
    if (cur.serverSecMs - prev.serverSecMs === 1000) {
      // The tick (server crossing into cur.serverSecMs) occurred after prev's response and
      // before cur's request — i.e. within [prev.t1-ish, cur.t0-ish]; use the midpoints' span
      // as a conservative process-clock bracket, centered for the point estimate.
      const tickMidMs = (prev.midMs + cur.midMs) / 2;
      const halfGapMs = Math.abs(cur.midMs - prev.midMs) / 2;
      if (!best || halfGapMs < best.halfGapMs) {
        best = { tickServerMs: cur.serverSecMs, tickMidMs, halfGapMs };
      }
    }
  }

  if (best) {
    // offset = (server tick instant) − (our clock at that instant). confidence is the bracket
    // half-gap plus half the tightest RTT (asymmetry of the request/response legs).
    const offsetMs = best.tickServerMs - best.tickMidMs;
    const confidenceMs = best.halfGapMs + minRttMs / 2;
    return { offsetMs, confidenceMs, minRttMs };
  }

  // No rollover observed (all samples landed in one server-second): fall back to the tightest
  // single sample. Its emission instant is somewhere in [S, S+1000) with midpoint estimate
  // S+500, so offset ≈ (S+500) − mid with ±(500 + minRtt/2) confidence.
  const tightest = samples.reduce((a, b) => (b.rttMs < a.rttMs ? b : a));
  const offsetMs = tightest.serverSecMs + 500 - tightest.midMs;
  const confidenceMs = 500 + minRttMs / 2;
  return { offsetMs, confidenceMs, minRttMs };
}

/**
 * Calibrate our process clock against Tock's origin clock from a warm, Cloudflare-passing page.
 *
 * Issues ~`samples` in-page GETs to https://www.exploretock.com/ (in-page so the request rides
 * this context's cf_clearance + TLS fingerprint — a raw Node fetch would be challenged, spec §3),
 * reading the `date` response header and bracketing each with `performance.now()` before/after to
 * bound RTT. It spins the requests back-to-back so at least one pair straddles a server-second
 * boundary; `computeCalibration` then pins the second-phase from that rollover.
 *
 * Returns {offsetMs, confidenceMs, minRttMs}. On total failure (page navigated, all requests
 * threw) it returns confidenceMs = +Infinity so the caller's arm hard-gate fails closed rather
 * than firing on a bogus clock.
 */
export async function calibrateClock(page: Page, samples = 6): Promise<ClockCalibration> {
  const raw = await page.evaluate(async (n: number) => {
    const out: Array<{ dateHeader: string | null; t0: number; t1: number }> = [];
    for (let i = 0; i < n; i++) {
      const t0 = performance.now();
      try {
        // cache-buster query so a CDN/browser cache can't serve a stale (wrong-time) response.
        // Runs in the renderer, where `cache` is a valid RequestInit field (Node's lib types
        // that tsc sees here omit it) — cast to keep the browser-correct no-store behavior.
        const r = await fetch(`/?_c=${Date.now()}_${i}`, { method: 'GET', credentials: 'include', cache: 'no-store' } as any);
        const t1 = performance.now();
        out.push({ dateHeader: r.headers.get('date'), t0, t1 });
        // brief spacing so consecutive samples spread across the second boundary, not clump.
        await new Promise(res => setTimeout(res, 120));
      } catch {
        out.push({ dateHeader: null, t0, t1: performance.now() });
      }
    }
    // performance.now() is monotonic-from-navigation; anchor it to wall-clock so offsetMs is
    // relative to Date.now() (what callers compare against), not to page-load.
    return { at: Date.now(), origin: performance.now(), rows: out };
  }, samples).catch(() => null);

  if (!raw || raw.rows.length === 0) {
    return { offsetMs: 0, confidenceMs: Number.POSITIVE_INFINITY, minRttMs: Number.POSITIVE_INFINITY };
  }

  // Convert the page-relative performance.now() timeline into wall-clock epoch-ms using the
  // single anchor captured above (perfNow=raw.origin ⇔ epoch=raw.at), so samples are directly
  // comparable to the server `date` header.
  const perfToEpoch = (perf: number) => raw.at + (perf - raw.origin);
  const built: ClockSample[] = [];
  for (const row of raw.rows) {
    const serverSecMs = parseDateHeaderMs(row.dateHeader);
    if (serverSecMs == null) continue; // drop a sample that carried no parseable Date header
    const t0 = perfToEpoch(row.t0);
    const t1 = perfToEpoch(row.t1);
    built.push({ serverSecMs, t0, t1, midMs: (t0 + t1) / 2, rttMs: t1 - t0 });
  }

  return computeCalibration(built);
}

/** DST-correct UTC-offset (in minutes, e.g. -420 for PDT, -480 for PST) that America/Los_Angeles
 *  was at on the given UTC instant. PURE. Derived from `Intl` parts, never hardcoded — the wall
 *  clock's offset flips on DST-change days and a fixed -8/-7 guess mis-fires the drop by an hour. */
function laOffsetMinutes(utcMs: number): number {
  // Format the instant AS Los_Angeles wall-time, then read that wall-time back as if it were UTC;
  // the difference is the zone's offset at that instant (handles PDT vs PST automatically).
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Los_Angeles',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  });
  const p: Record<string, string> = {};
  for (const part of dtf.formatToParts(new Date(utcMs))) p[part.type] = part.value;
  // Intl renders midnight as "24" in some engines; normalize to "00".
  const hour = p.hour === '24' ? '00' : p.hour;
  const asUtc = Date.UTC(
    Number(p.year), Number(p.month) - 1, Number(p.day),
    Number(hour), Number(p.minute), Number(p.second),
  );
  return (asUtc - utcMs) / 60000;
}

/**
 * Epoch-ms of the drop instant described by `dropIso`. PURE, DST-correct for America/Los_Angeles.
 *
 * Two accepted shapes:
 *   - Zoned ISO ("2026-07-11T03:00:00Z" or "...-07:00"): already unambiguous — `Date.parse`.
 *   - Bare local wall-time ("2026-07-11T20:00" / "2026-07-11T20:00:00", no zone): interpreted as
 *     America/Los_Angeles wall-time and converted to UTC using the *actual* zone offset on that
 *     date (PDT vs PST resolved via `laOffsetMinutes`), NOT a hardcoded ±8h.
 *
 * Throws on an unparseable string so a mis-typed drop time fails loudly at arm-time, never
 * silently fires at the wrong instant.
 */
export function t0Epoch(dropIso: string): number {
  const s = String(dropIso).trim();
  // Zoned? (trailing Z, or a ±HH:MM / ±HHMM offset after the time). Let the engine parse it.
  if (/[zZ]$/.test(s) || /[+-]\d{2}:?\d{2}$/.test(s)) {
    const ms = Date.parse(s);
    if (!Number.isFinite(ms)) throw new Error(`t0Epoch: unparseable zoned drop time "${dropIso}"`);
    return ms;
  }

  // Bare wall-time. Parse the fields directly (do NOT Date.parse — that would apply the SERVER's
  // local zone, which on Railway is UTC, giving the wrong instant).
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?$/);
  if (!m) throw new Error(`t0Epoch: unrecognized drop time "${dropIso}" (want ISO "YYYY-MM-DDTHH:MM[:SS][Z]")`);
  const [, y, mo, d, h, mi, se] = m;
  // Reject out-of-range components explicitly: Date.UTC would SILENTLY overflow-normalize (month
  // 13 → next Jan, day 99 → weeks later), mis-firing the drop by weeks instead of failing loudly.
  const moN = Number(mo), dN = Number(d), hN = Number(h), miN = Number(mi), seN = Number(se || '0');
  if (moN < 1 || moN > 12 || dN < 1 || dN > 31 || hN > 23 || miN > 59 || seN > 59) {
    throw new Error(`t0Epoch: unrecognized drop time "${dropIso}" (component out of range)`);
  }
  // First treat the wall-time as if it were UTC, then correct by the zone offset AT that instant.
  // Because the offset can differ by ≤1h from the naive guess, resolve it against the corrected
  // instant once (a second pass would only matter within the ~1h DST-transition gap, which no
  // 8pm/10am drop lands in — the drop times this engine targets are never in the 2–3am fold).
  const naiveUtc = Date.UTC(Number(y), moN - 1, dN, hN, miN, seN);
  const offMin = laOffsetMinutes(naiveUtc);
  return naiveUtc - offMin * 60000;
}

/**
 * Local-epoch helper retained for spec §2 naming (`t0Local(dropIso, offsetMs)`): the drop instant
 * as OUR process-clock would read it, i.e. Tock's T0 minus the measured clock offset. Callers that
 * schedule off Date.now() use this so the busy-spin target is in the same timebase as their clock.
 * PURE. `offsetMs` is `serverClock − ourClock` from `calibrateClock`.
 */
export function t0Local(dropIso: string, offsetMs = 0): number {
  return t0Epoch(dropIso) - offsetMs;
}

/**
 * The instant to actually SEND the lock PUT so it ARRIVES at the origin at the drop edge. PURE.
 *
 * fireAt = edgeEpochMs − minRttMs − leadMs
 *
 * We back off the one-way flight time (approximated by the full RTT floor — conservative, biases
 * early) plus a small operator `leadMs` cushion. Firing a hair early is FREE: an early PUT returns
 * a not-yet-open conflict and simply retries within the sustain window; firing late loses. Callers
 * pass `edgeEpochMs` in the timebase they'll compare against Date.now() (see `t0Local`).
 */
export function computeFireAt(edgeEpochMs: number, minRttMs: number, leadMs: number): number {
  // Guard against an uncalibrated +Infinity RTT poisoning the schedule into the distant past.
  const rtt = Number.isFinite(minRttMs) ? minRttMs : 0;
  const lead = Number.isFinite(leadMs) ? leadMs : 0;
  return edgeEpochMs - rtt - lead;
}
