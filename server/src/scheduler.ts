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
import { runBooking, BookingRequest } from './booker';
import { BlitzConfig, runBlitz, AttemptOutcome } from './blitz';
import { runSniper, SniperConfig, SniperResult, SniperSeen } from './sniper';
import { notifyResult } from './notify';

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
// Run history, newest-first (entries are unshift'd). Bounded to 50 via addToHistory(); note
// executeBooking() unshifts directly and does NOT trim, so scheduled runs can exceed 50.
const bookingHistory: BookingHistoryEntry[] = [];

/**
 * Seed schedules at boot from the SCHEDULED_BOOKINGS env var.
 *
 * The var holds a base64-encoded JSON array of ScheduledBooking — base64 so a multi-line
 * JSON blob survives being stored as a single Railway env value. A parse failure is logged
 * and swallowed (server still starts with zero schedules) rather than crashing boot.
 */
export function startScheduler(): void {
  const raw = process.env.SCHEDULED_BOOKINGS;
  if (!raw) {
    console.log('📅 No scheduled bookings configured');
    return;
  }

  let bookings: ScheduledBooking[];
  try {
    bookings = JSON.parse(Buffer.from(raw, 'base64').toString('utf-8'));
  } catch (err) {
    console.error('Failed to parse SCHEDULED_BOOKINGS:', err);
    return;
  }

  console.log(`📅 Starting ${bookings.length} scheduled booking(s)`);
  for (const booking of bookings) {
    addScheduledBooking(booking);
  }
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
      const blitzResult = await runBlitz(booking, booking.blitz, booking.runAt);
      result = blitzResult.result;
      blitzMeta = {
        winningAttempt: blitzResult.winningAttempt,
        totalAttempted: blitzResult.totalAttempted,
        totalAborted: blitzResult.totalAborted,
        durationMs: blitzResult.durationMs,
        attempts: blitzResult.attempts,
      };
    } else {
      result = await runBooking(booking);
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
      blitzMeta,
      sniperMeta,
    };
    bookingHistory.unshift(entry);
    schedulerEvents.emit('booking-result', entry);
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
    };
    bookingHistory.unshift(entry);
    schedulerEvents.emit('booking-result', entry);
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
export function addScheduledBooking(booking: ScheduledBooking): { success: boolean; error?: string } {
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
    // For blitz/sniper, fire early to allow browser pre-launch + warmup (~15s).
    // Those engines use runAt for precise stagger/window timing internally.
    const targetTime = new Date(booking.runAt).getTime();
    // Reject clearly-past targets, but tolerate up to 5s of slack (clock skew / request
    // latency between the client picking a time and this running). A just-past target still
    // fires immediately because delayMs is clamped to >= 0 below.
    if (targetTime - Date.now() < -5000) {
      return { success: false, error: `Run time is in the past (${Math.round((Date.now() - targetTime) / 1000)}s ago)` };
    }
    // Plain bookings fire exactly at target (earlyMs 0); sniper/blitz fire 15s early to cover
    // browser pre-launch + warmup so the engine is hot and ready to strike at the true `runAt`.
    const needsWarmup = booking.sniper || (booking.blitz && booking.blitz.attempts > 1);
    const earlyMs = needsWarmup ? 15_000 : 0;
    const delayMs = Math.max(0, targetTime - earlyMs - Date.now());

    const timer = setTimeout(() => {
      executeBooking(booking);
      // One-shot: remove from the registry after firing so it can't be re-triggered and
      // doesn't linger in getScheduledBookings(). (No trim of bookingHistory happens here.)
      scheduledBookings.delete(booking.id);
    }, delayMs);

    task = { stop: () => clearTimeout(timer) };

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
  return { success: true };
}

/** Cancel and unregister a schedule by id. Stops its underlying cron/timeout so it can't fire
 *  again. Returns false if no such id is registered (already fired one-shots included). */
export function removeScheduledBooking(id: string): boolean {
  const entry = scheduledBookings.get(id);
  if (!entry) return false;
  entry.task.stop();
  scheduledBookings.delete(id);
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
  return true;
}

/** Wipe all run history in place (keeps the same array reference held by getHistory callers). */
export function clearHistory(): void {
  bookingHistory.length = 0;
}
