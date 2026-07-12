/**
 * scheduler.ts — in-memory scheduling and run history for the booking server.
 *
 * Single responsibility: own *when* a booking fires and *what happened* after it did.
 * It holds two in-memory registries — a Map of live schedules (each backed by either a
 * cron task or a one-shot setTimeout) and an array of past run results — and dispatches
 * each fired schedule to the right engine (sniper > blitz > single-shot booking),
 * capturing engine-specific diagnostics (sniperMeta / blitzMeta) alongside the result.
 *
 * Persistence model: NOTHING here survives a process restart. Schedules are seeded once
 * at boot from the base64-encoded SCHEDULED_BOOKINGS env var; history lives only in the
 * `bookingHistory` array. Railway redeploys therefore wipe both — callers that need
 * durability persist elsewhere (see store.ts). This is deliberate: the data is meant to
 * be queryable by the dashboard/API while the process lives, not to be a system of record.
 *
 * Consumers subscribe to `schedulerEvents` ('booking-result') to stream results to the
 * dashboard (e.g. via SSE) as each run completes, without polling.
 *
 * Key exports:
 *  - schedulerEvents           — EventEmitter; emits 'booking-result' per completed run
 *  - ScheduledBooking          — a schedule (cron or runAt) plus its booking payload
 *  - BookingHistoryEntry       — one recorded run outcome (+ engine meta)
 *  - SniperMeta / BlitzMeta    — engine-specific diagnostics for a run
 *  - startScheduler()          — seed schedules from env at boot
 *  - addScheduledBooking()     — register/replace a schedule
 *  - removeScheduledBooking()  — cancel + unregister a schedule
 *  - getScheduledBookings()    — list live schedules
 *  - addToHistory() / getHistory() / deleteHistoryEntry() / clearHistory() — history CRUD
 */
import cron from 'node-cron';
import { EventEmitter } from 'events';
import { BookingRequest } from './booker';
import { BlitzConfig, AttemptOutcome } from './blitz';
import { runSniper, SniperConfig, SniperResult, SniperSeen } from './sniper';
import { notifyResult } from './notify';
import { getBookingEngine } from './engines';
import { saveToDisk, loadFromDisk } from './store';

/**
 * Process-wide bus for run outcomes. `executeBooking` emits 'booking-result' with the
 * `BookingHistoryEntry` immediately after each run (success or crash), which the Express
 * layer forwards to connected dashboard clients so results appear live.
 */
export const schedulerEvents = new EventEmitter();

/**
 * A registered schedule: the booking payload (inherited from BookingRequest — restaurant,
 * dates, time, party size, etc.) plus the timing and engine selection.
 *
 * Timing is either/or: if `runAt` is present it wins and the schedule fires once via
 * setTimeout (then auto-removes); otherwise `cron` drives a recurring node-cron task.
 * Engine precedence at fire time is sniper > blitz > plain booking (see executeBooking).
 */
export interface ScheduledBooking extends BookingRequest {
  id: string;
  cron: string;          // cron expression e.g. "0 10 1 4 *"
  runAt?: string;        // ISO datetime — one-shot; when set, takes precedence over `cron`
  blitz?: BlitzConfig;   // optional blitz mode config (only engaged when attempts > 1)
  sniper?: SniperConfig; // optional sniper mode config (takes precedence over blitz)
  firedAt?: string;      // set the instant a one-shot fires, persisted BEFORE the run so a reload
                         // can tell "never fired" from "interrupted mid-run" (exactly-once, §design Q2)
  resumeCount?: number;  // times a firedAt job has been re-fired on reload — capped at 1 so a
                         // crash-loop can't re-charge repeatedly inside the grace window (§audit C2)
  label?: string;        // human-friendly label
  createdAt: string;     // ISO timestamp
}

/**
 * One recorded run outcome, newest-first in `bookingHistory`. `source` distinguishes runs
 * triggered by this scheduler ('scheduled') from ad-hoc runs pushed in via addToHistory()
 * ('manual'). `blitzMeta`/`sniperMeta` are populated only for the engine that actually ran,
 * so a miss is inspectable from the dashboard without server console access.
 */
export interface BookingHistoryEntry {
  id: string;
  restaurant: string;
  date?: string;
  time?: string;
  success: boolean;
  error?: string;
  screenshots?: string[];
  ranAt: string;         // ISO timestamp
  source: 'manual' | 'scheduled';
  scheduleId?: string;   // the ScheduledBooking.id this run came from — lets a reload tell that a
                         // firedAt job already COMPLETED (don't re-fire → no double-charge, §audit C1)
  blitzMeta?: BlitzMeta;
  sniperMeta?: SniperMeta;
}

/** Structured sniper diagnostics attached to the history entry, so a miss is inspectable
 *  from the dashboard/API without console access. History is in-memory like the logs —
 *  this doesn't survive a deploy restart, it just makes the data queryable while it lives. */
export interface SniperMeta {
  polls?: SniperResult['polls'];
  seen?: SniperSeen;
  durationMs?: number;
}

/**
 * Diagnostics for a blitz run (N parallel booking attempts staggered by a few ms).
 * `winningAttempt` is the 1-based index of the attempt that secured the slot (undefined on
 * a full miss); `totalAborted` counts attempts that self-cancelled once another won the race.
 */
export interface BlitzMeta {
  winningAttempt?: number;
  totalAttempted?: number;
  totalAborted?: number;
  durationMs?: number;
  attempts?: AttemptOutcome[]; // per-attempt outcomes (why each one failed)
}

/** Minimal shape both a node-cron task and a setTimeout wrapper satisfy, so the registry can
 *  cancel either uniformly without caring which timing mechanism backs it. */
interface Stoppable { stop(): void; }
// Live schedules keyed by booking id. Storing the `task` alongside the booking lets us stop
// the underlying cron/timeout when the schedule is replaced or removed. In-memory only.
const scheduledBookings: Map<string, { booking: ScheduledBooking; task: Stoppable }> = new Map();
// Run history, newest-first (entries are unshift'd). Bounded to 50 everywhere now (executeBooking,
// addToHistory, and the reload path all trim), so scheduled runs no longer grow it unbounded.
const bookingHistory: BookingHistoryEntry[] = [];

// ================================================================================================
// Durable persistence: armed jobs + run history are mirrored to the /data volume via store.ts so a
// redeploy (which wipes all in-memory scheduler state) can't lose an armed FHH job. Disk is the
// source of truth for the next boot; the SCHEDULED_BOOKINGS env is bootstrap-only.
// ================================================================================================

/** setTimeout fires IMMEDIATELY for a delay > 2^31−1 ms (~24.86 days). A job armed weeks out
 *  (now normal once schedules persist across deploys) would otherwise fire ~24 days early and poll
 *  Tock for weeks. Chain timeouts in ≤MAX_TIMEOUT_MS hops so any delay is honoured. */
const MAX_TIMEOUT_MS = 2_147_483_647;
function scheduleAt(delayMs: number, fn: () => void): Stoppable {
  let timer: ReturnType<typeof setTimeout>;
  const arm = (remaining: number): void => {
    timer = remaining > MAX_TIMEOUT_MS
      ? setTimeout(() => arm(remaining - MAX_TIMEOUT_MS), MAX_TIMEOUT_MS)
      : setTimeout(fn, Math.max(0, remaining));
  };
  arm(delayMs);
  return { stop: () => clearTimeout(timer) };
}

/** Mirror the live schedule registry (incl. each one-shot's firedAt marker) to disk. Called after
 *  every mutation so the disk copy is always the source of truth for the next boot. Best-effort. */
function persistSchedules(): void {
  try {
    saveToDisk('scheduledBookings', Array.from(scheduledBookings.values()).map(e => e.booking));
  } catch (err) {
    console.error('Failed to persist schedules:', err);
  }
}

/** Mirror run history to disk — screenshots STRIPPED (base64 PNGs would bloat state.json by MB and
 *  slow every unrelated saveToDisk, incl. cookie writes) and capped to the newest 50. */
function persistHistory(): void {
  try {
    saveToDisk('bookingHistory', bookingHistory.slice(0, 50).map(e => ({ ...e, screenshots: undefined })));
  } catch (err) {
    console.error('Failed to persist history:', err);
  }
}

/** Emit a booking-result without letting a throwing/slow SSE listener break the caller (§audit I1):
 *  a listener that throws must not abort executeBooking's success path (which would append a
 *  contradictory failure entry) or skip a fireNow cleanup. */
function safeEmit(entry: BookingHistoryEntry): void {
  try { schedulerEvents.emit('booking-result', entry); }
  catch (err) { console.error('booking-result emit failed:', err); }
}

/** Record a run that could NOT be re-armed on reload (downtime straddled its runAt, or it was
 *  interrupted mid-run) as a persisted history entry + notification, so a miss is never silent. */
async function recordSkipped(booking: ScheduledBooking, reason: string): Promise<void> {
  const entry: BookingHistoryEntry = {
    id: crypto.randomUUID(),
    restaurant: booking.restaurant,
    success: false,
    error: `MISSED (${booking.label || booking.restaurant}): ${reason}`,
    ranAt: new Date().toISOString(),
    source: 'scheduled',
    scheduleId: booking.id,
  };
  bookingHistory.unshift(entry);
  if (bookingHistory.length > 50) bookingHistory.length = 50;
  persistHistory();
  safeEmit(entry);
  await notifyResult(booking.restaurant, { success: false, error: entry.error } as import('./booker').BookingResult).catch(() => {});
}

/** Fire a one-shot NOW (grace-fire a just-missed job on reload, or resume an interrupted run).
 *  Two-phase exactly-once: stamp+persist firedAt BEFORE running (so an interrupted retry is
 *  distinguishable), keep it in the Map (dashboard shows it running), then remove+persist on
 *  completion via `finally` (so an unexpected reject still cleans up + doesn't leave firedAt stuck
 *  → a spurious resume next boot, §audit I1). Non-blocking so a minutes-long run doesn't hold boot. */
function fireNow(booking: ScheduledBooking): void {
  booking.firedAt = booking.firedAt || new Date().toISOString();
  scheduledBookings.set(booking.id, { booking, task: { stop: () => {} } });
  persistSchedules();
  void (async () => {
    try { await executeBooking(booking); }
    finally { scheduledBookings.delete(booking.id); persistSchedules(); }
  })();
}

/**
 * Bootstrap the scheduler at boot. DISK-FIRST so armed jobs survive redeploys:
 *  - Restore run history from disk (screenshots were stripped on write).
 *  - If the schedules key exists on disk (even `[]`) it is AUTHORITATIVE — reload it via the
 *    decision table in reloadPersistedSchedules. SCHEDULED_BOOKINGS env is bootstrap-only: seeded
 *    only when the disk key is absent (`null`), then immediately persisted — otherwise an env job
 *    would resurrect a dashboard-deleted schedule or double-fire alongside its persisted copy.
 *
 * MUST run after loadCookiesFromEnv() (index.ts boot order) because a job inside its warm window
 * fires within milliseconds of boot and needs cookies loaded or the warm dies "signed out".
 */
export function startScheduler(): void {
  const persistedHistory = loadFromDisk('bookingHistory');
  if (Array.isArray(persistedHistory)) {
    bookingHistory.push(...persistedHistory);
    console.log(`📖 Restored ${persistedHistory.length} history entr(ies) from disk`);
  }

  const persisted = loadFromDisk('scheduledBookings');
  if (persisted == null) {
    seedSchedulesFromEnv();  // fresh volume, never persisted → one-time env bootstrap
    persistSchedules();
    return;
  }
  reloadPersistedSchedules(Array.isArray(persisted) ? persisted : []);
}

/** One-time bootstrap: seed schedules from the base64 SCHEDULED_BOOKINGS env var. Only runs on the
 *  very first boot (disk has no schedules key). A parse failure is logged + swallowed, never fatal. */
function seedSchedulesFromEnv(): void {
  const raw = process.env.SCHEDULED_BOOKINGS;
  if (!raw) {
    console.log('📅 No scheduled bookings configured (no disk state, no env)');
    return;
  }
  let bookings: ScheduledBooking[];
  try {
    bookings = JSON.parse(Buffer.from(raw, 'base64').toString('utf-8'));
  } catch (err) {
    console.error('Failed to parse SCHEDULED_BOOKINGS:', err);
    return;
  }
  console.log(`📅 Seeding ${bookings.length} scheduled booking(s) from env (first boot)`);
  for (const booking of bookings) addScheduledBooking(booking);
}

/** What to do with a persisted one-shot on reload (§design decision table). PURE + exported so the
 *  FHH-critical timing logic is unit-testable without the scheduler's browser/timer machinery:
 *   - future runAt                        → 'rearm'
 *   - just-missed (≤ grace)               → 'fire-now'          (deploy/crash straddled the drop)
 *   - long-missed (> grace)               → 'skip-missed'       (stale; record + notify, don't fire)
 *   - firedAt set, ≤ grace past runAt     → 'resume-interrupted'(re-fire an interrupted run)
 *   - firedAt set, > grace past runAt     → 'skip-unknown'      (possible partial charge; notify) */
export type ReloadAction = 'rearm' | 'fire-now' | 'resume-interrupted' | 'skip-missed' | 'skip-unknown';
export function reloadAction(runAtMs: number, firedAt: string | undefined, nowMs: number, graceMs = 10 * 60_000): ReloadAction {
  const pastMs = nowMs - runAtMs;
  if (firedAt) return pastMs <= graceMs ? 'resume-interrupted' : 'skip-unknown';
  if (pastMs < 0) return 'rearm';
  return pastMs <= graceMs ? 'fire-now' : 'skip-missed';
}

/** Reload persisted schedules on boot via the exactly-once + grace-fire decision table. Per-item
 *  fault isolation: one corrupt record is skipped+logged, never aborting the loop (a bad neighbour
 *  can't stop FHH re-arming). Reconciles disk to the live Map at the end. */
function reloadPersistedSchedules(jobs: ScheduledBooking[]): void {
  console.log(`📅 Reloading ${jobs.length} persisted schedule(s) from disk`);
  for (const job of jobs) {
    try {
      if (!job.runAt) { addScheduledBooking(job); continue; } // cron → re-register (missed ticks dropped, as before)
      const pastMs = Date.now() - new Date(job.runAt).getTime();
      switch (reloadAction(new Date(job.runAt).getTime(), job.firedAt, Date.now())) {
        case 'rearm':
          addScheduledBooking(job); break;
        case 'fire-now':
          console.log(`   ⏱️ grace-firing (runAt ${Math.round(pastMs / 1000)}s ago): ${job.label || job.restaurant}`);
          fireNow(job); break;
        case 'resume-interrupted': {
          // Only re-fire if the run did NOT already complete — otherwise resuming re-runs a booking
          // that may have already charged the card (§audit C1). The restored history (loaded above,
          // before this) is the cross-restart idempotency record: a completed run left an entry
          // tagged with this schedule's id at/after firedAt.
          const completed = job.firedAt != null &&
            bookingHistory.some(h => h.scheduleId === job.id && h.ranAt >= job.firedAt!);
          if (completed) {
            console.log(`   ✓ interrupted run already completed (history present) — not re-firing: ${job.label || job.restaurant}`);
            break; // drop (reconcile persist removes it from disk)
          }
          if ((job.resumeCount ?? 0) >= 1) { // cap re-fires so a crash-loop can't re-charge repeatedly (§audit C2)
            void recordSkipped(job, 'interrupted run already resumed once, outcome unknown — check the Tock account'); break;
          }
          console.log(`   ↻ resuming interrupted run: ${job.label || job.restaurant}`);
          job.resumeCount = (job.resumeCount ?? 0) + 1;
          fireNow(job);
          break;
        }
        case 'skip-missed':
          void recordSkipped(job, `runAt was ${Math.round(pastMs / 60000)}min ago (downtime straddled the drop)`); break;
        case 'skip-unknown':
          void recordSkipped(job, 'interrupted run, unknown outcome — check the Tock account'); break;
      }
    } catch (err) {
      console.error(`   ⚠️ skipping corrupt persisted schedule (${job?.id || '?'}):`, err);
    }
  }
  persistSchedules(); // reconcile: fired/dropped jobs are gone from the Map → removed from disk
}

/**
 * The callback that runs when a schedule fires (from cron or setTimeout). Selects the engine,
 * records a history entry, emits it on `schedulerEvents`, and fires a notification.
 *
 * Engine precedence (mutually exclusive per run):
 *   1. sniper  — drop-capture; passed `runAt` so it can time its own poll window/stagger.
 *   2. blitz   — only when configured AND attempts > 1 (attempts <= 1 falls through to single-shot).
 *   3. booking — plain single-shot.
 *
 * The `runAt` handed to sniper/blitz is the ORIGINAL target time, not the (earlier) timer
 * firing time — those engines pre-launch/warm up ahead of `runAt` and need the true target
 * for precise internal timing (see the earlyMs warmup in addScheduledBooking).
 *
 * Fail-soft: any throw from an engine is caught and still recorded as a failed history entry
 * (+ emitted) so a crash surfaces in the dashboard instead of vanishing silently. Note the
 * catch path deliberately skips notifyResult — a crashed run has no BookingResult to notify on.
 */
async function executeBooking(booking: ScheduledBooking): Promise<void> {
  try {
    console.log(`\n⏰ Triggered: ${booking.label || booking.restaurant}`);

    let result: import('./booker').BookingResult;
    let blitzMeta: BlitzMeta | undefined;
    let sniperMeta: SniperMeta | undefined;

    if (booking.sniper) {
      const sniperResult = await runSniper(booking, booking.sniper, booking.runAt);
      result = sniperResult;
      sniperMeta = { polls: sniperResult.polls, seen: sniperResult.seen, durationMs: sniperResult.durationMs };
    } else if (booking.blitz && booking.blitz.attempts > 1) {
      const engine = getBookingEngine(booking.platform);
      const blitzResult = await engine.runBlitz(booking, booking.blitz, booking.runAt);
      result = blitzResult.result;
      blitzMeta = {
        winningAttempt: blitzResult.winningAttempt,
        totalAttempted: blitzResult.totalAttempted,
        totalAborted: blitzResult.totalAborted,
        durationMs: blitzResult.durationMs,
        attempts: blitzResult.attempts,
      };
    } else {
      const engine = getBookingEngine(booking.platform);
      result = await engine.runBooking(booking);
    }

    const entry: BookingHistoryEntry = {
      id: crypto.randomUUID(),
      restaurant: booking.restaurant,
      date: result.bookedDate,
      time: result.bookedTime,
      success: result.success,
      error: result.error,
      screenshots: result.screenshots,
      ranAt: new Date().toISOString(),
      source: 'scheduled',
      scheduleId: booking.id,   // link the run to its schedule so a reload can detect completion (§audit C1)
      blitzMeta,
      sniperMeta,
    };
    bookingHistory.unshift(entry);
    if (bookingHistory.length > 50) bookingHistory.length = 50;
    persistHistory();
    safeEmit(entry);
    await notifyResult(booking.restaurant, result, blitzMeta);
  } catch (err) {
    console.error(`❌ Scheduled booking crashed: ${booking.label || booking.restaurant}`, err);
    const entry: BookingHistoryEntry = {
      id: crypto.randomUUID(),
      restaurant: booking.restaurant,
      success: false,
      error: err instanceof Error ? err.message : String(err),
      ranAt: new Date().toISOString(),
      source: 'scheduled',
      scheduleId: booking.id,
    };
    bookingHistory.unshift(entry);
    if (bookingHistory.length > 50) bookingHistory.length = 50;
    persistHistory();
    safeEmit(entry);
  }
}

/**
 * Register (or replace) a schedule. Idempotent by `booking.id`: re-adding the same id stops
 * the prior task first, so this doubles as the update path. Returns a result object rather
 * than throwing so the HTTP layer can surface validation errors (past time / bad cron) to the UI.
 *
 * Timing branch:
 *  - `runAt` present → one-shot setTimeout that self-removes from the registry after firing.
 *  - otherwise       → recurring node-cron task.
 */
export function addScheduledBooking(booking: ScheduledBooking): { success: boolean; error?: string; persisted?: boolean } {
  if (!booking.id) booking.id = crypto.randomUUID();
  if (!booking.createdAt) booking.createdAt = new Date().toISOString();

  // Replacing an existing schedule: stop its live cron/timeout before overwriting the entry,
  // otherwise the old task keeps firing (leak / duplicate runs).
  if (scheduledBookings.has(booking.id)) {
    scheduledBookings.get(booking.id)!.task.stop();
  }

  let task: Stoppable;

  if (booking.runAt) {
    // Use setTimeout for exact datetime scheduling.
    // For blitz/sniper, fire early to allow browser pre-launch + warmup.
    // Those engines use runAt for precise stagger/window timing internally.
    const targetTime = new Date(booking.runAt).getTime();
    // Reject clearly-past targets, but tolerate up to 5s of slack (clock skew / request
    // latency between the client picking a time and this running). A just-past target still
    // fires immediately because delayMs is clamped to >= 0 below.
    if (targetTime - Date.now() < -5000) {
      return { success: false, error: `Run time is in the past (${Math.round((Date.now() - targetTime) / 1000)}s ago)` };
    }
    // How far ahead of the true `runAt` we fire the timer, to give the engine time to get hot:
    //  - plain booking → 0 (fire exactly at target).
    //  - blitz         → 15s (browser pre-launch + warmup only).
    //  - sniper        → ~120s. The volley engine must warm the pool AND calibrate its clock
    //    AND reconcile experience/price AND arm the renderer fire loop BEFORE T0 — a 15s lead
    //    isn't enough for that pipeline (see win-fhh-design §2.2 firing schedule). We still hand
    //    the ORIGINAL `runAt` to executeBooking → runSniper below; the engine derives the true
    //    drop instant + its own send lead internally, so a longer timer lead only means it warms
    //    earlier, never that it fires early. Config-driven via the SNIPER_WARM_LEAD_MS env var
    //    when present (clamped to a 15s floor so it can't be tuned below usable warmup).
    const SNIPER_WARM_LEAD_MS = Math.max(Number(process.env.SNIPER_WARM_LEAD_MS) || 120_000, 15_000);
    let earlyMs: number;
    if (booking.sniper) {
      earlyMs = SNIPER_WARM_LEAD_MS;
    } else if (booking.blitz && booking.blitz.attempts > 1) {
      earlyMs = 15_000;
    } else {
      earlyMs = 0;
    }
    const delayMs = Math.max(0, targetTime - earlyMs - Date.now());

    // scheduleAt (not raw setTimeout) so a >24.86-day delay doesn't overflow and fire immediately.
    // Two-phase exactly-once: stamp+persist firedAt BEFORE the run so a reload can tell a never-fired
    // job from one interrupted mid-run; await the run; then remove from the registry + persist so a
    // completed one-shot can't reload and re-fire on the next boot (§design Q2).
    task = scheduleAt(delayMs, () => {
      booking.firedAt = new Date().toISOString();
      persistSchedules();
      void (async () => {
        // finally (not a bare sequence) so an unexpected reject still removes the job + persists —
        // otherwise firedAt stays on disk and next boot spuriously resumes/flags it (§audit I1).
        try { await executeBooking(booking); }
        finally { scheduledBookings.delete(booking.id); persistSchedules(); }
      })();
    });

    const blitzLabel = booking.blitz && booking.blitz.attempts > 1
      ? ` [blitz: ${booking.blitz.attempts}x @ ${booking.blitz.staggerMs}ms]`
      : '';
    console.log(`   📅 ${booking.label || booking.restaurant}: fires in ${Math.round(delayMs / 1000)}s → ${booking.dates.join(', ')} at ${booking.time}${blitzLabel}`);
  } else {
    // No runAt → recurring node-cron task. Validate up front so a typo'd expression is
    // reported to the caller instead of silently never firing. Recurring tasks are NOT
    // auto-removed after firing (unlike the setTimeout branch).
    if (!cron.validate(booking.cron)) {
      return { success: false, error: `Invalid cron expression: ${booking.cron}` };
    }

    const cronTask = cron.schedule(booking.cron, () => executeBooking(booking));
    task = { stop: () => cronTask.stop() };

    console.log(`   📅 ${booking.label || booking.restaurant}: "${booking.cron}" → ${booking.dates.join(', ')} at ${booking.time}`);
  }

  scheduledBookings.set(booking.id, { booking, task });
  persistSchedules();
  // Read back so the HTTP layer can surface silent persistence degradation (e.g. /data volume not
  // mounted → saveToDisk logs + continues): an armed-but-not-durable job would otherwise vanish on
  // the next redeploy with no warning. `persisted:false` lets the dashboard show "ARMED (NOT DURABLE)".
  const persistedJobs = loadFromDisk('scheduledBookings');
  const persisted = Array.isArray(persistedJobs) && persistedJobs.some((j: { id?: string }) => j.id === booking.id);
  return { success: true, persisted };
}

/** Cancel and unregister a schedule by id. Stops its underlying cron/timeout so it can't fire
 *  again. Returns false if no such id is registered (already fired one-shots included). */
export function removeScheduledBooking(id: string): boolean {
  const entry = scheduledBookings.get(id);
  if (!entry) return false;
  entry.task.stop();
  scheduledBookings.delete(id);
  persistSchedules(); // durable delete: a cancelled job must not resurrect from disk on the next boot
  return true;
}

/** Snapshot of the currently-live schedules (for the dashboard/API). One-shot runAt schedules
 *  disappear from this list once they fire; recurring cron schedules persist until removed. */
export function getScheduledBookings(): ScheduledBooking[] {
  return Array.from(scheduledBookings.values()).map(e => e.booking);
}

/**
 * Record an externally-produced run outcome (e.g. a manual booking made outside the scheduler).
 * This is the ONLY writer that bounds history to the most recent 50 entries — scheduled runs
 * unshift directly in executeBooking() and are not trimmed here.
 */
export function addToHistory(entry: BookingHistoryEntry): void {
  bookingHistory.unshift(entry);
  // Keep last 50 entries (drop the oldest by truncating the tail)
  if (bookingHistory.length > 50) bookingHistory.length = 50;
  persistHistory();
}

/** Get the full run history, newest-first. Returns the live array (not a copy) — callers
 *  must not mutate it. In-memory only; empty after a restart. */
export function getHistory(): BookingHistoryEntry[] {
  return bookingHistory;
}

/** Delete a single history entry by id. Returns false if the id isn't present. */
export function deleteHistoryEntry(id: string): boolean {
  const idx = bookingHistory.findIndex(e => e.id === id);
  if (idx < 0) return false;
  bookingHistory.splice(idx, 1);
  persistHistory();
  return true;
}

/** Wipe all run history in place (keeps the same array reference held by getHistory callers). */
export function clearHistory(): void {
  bookingHistory.length = 0;
  persistHistory();
}
