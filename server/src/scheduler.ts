import cron from 'node-cron';
import { EventEmitter } from 'events';
import { runBooking, BookingRequest } from './booker';
import { BlitzConfig, runBlitz, AttemptOutcome } from './blitz';
import { runSniper, SniperConfig } from './sniper';
import { notifyResult } from './notify';

export const schedulerEvents = new EventEmitter();

export interface ScheduledBooking extends BookingRequest {
  id: string;
  cron: string;          // cron expression e.g. "0 10 1 4 *"
  runAt?: string;        // ISO datetime — converted to cron on save
  blitz?: BlitzConfig;   // optional blitz mode config
  sniper?: SniperConfig; // optional sniper mode config (takes precedence over blitz)
  label?: string;        // human-friendly label
  createdAt: string;     // ISO timestamp
}

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
}

export interface BlitzMeta {
  winningAttempt?: number;
  totalAttempted?: number;
  totalAborted?: number;
  durationMs?: number;
  attempts?: AttemptOutcome[]; // per-attempt outcomes (why each one failed)
}

interface Stoppable { stop(): void; }
const scheduledBookings: Map<string, { booking: ScheduledBooking; task: Stoppable }> = new Map();
const bookingHistory: BookingHistoryEntry[] = [];

/** Load scheduled bookings from SCHEDULED_BOOKINGS env var on startup */
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

/** The callback that runs when a booking fires (cron or setTimeout) */
async function executeBooking(booking: ScheduledBooking): Promise<void> {
  try {
    console.log(`\n⏰ Triggered: ${booking.label || booking.restaurant}`);

    let result: import('./booker').BookingResult;
    let blitzMeta: BlitzMeta | undefined;

    if (booking.sniper) {
      result = await runSniper(booking, booking.sniper, booking.runAt);
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

/** Add a scheduled booking. Uses setTimeout for runAt-based schedules, cron for recurring. */
export function addScheduledBooking(booking: ScheduledBooking): { success: boolean; error?: string } {
  if (!booking.id) booking.id = crypto.randomUUID();
  if (!booking.createdAt) booking.createdAt = new Date().toISOString();

  // Stop existing task if updating
  if (scheduledBookings.has(booking.id)) {
    scheduledBookings.get(booking.id)!.task.stop();
  }

  let task: Stoppable;

  if (booking.runAt) {
    // Use setTimeout for exact datetime scheduling.
    // For blitz/sniper, fire early to allow browser pre-launch + warmup (~15s).
    // Those engines use runAt for precise stagger/window timing internally.
    const targetTime = new Date(booking.runAt).getTime();
    if (targetTime - Date.now() < -5000) {
      return { success: false, error: `Run time is in the past (${Math.round((Date.now() - targetTime) / 1000)}s ago)` };
    }
    const needsWarmup = booking.sniper || (booking.blitz && booking.blitz.attempts > 1);
    const earlyMs = needsWarmup ? 15_000 : 0;
    const delayMs = Math.max(0, targetTime - earlyMs - Date.now());

    const timer = setTimeout(() => {
      executeBooking(booking);
      // Auto-remove after execution
      scheduledBookings.delete(booking.id);
    }, delayMs);

    task = { stop: () => clearTimeout(timer) };

    const blitzLabel = booking.blitz && booking.blitz.attempts > 1
      ? ` [blitz: ${booking.blitz.attempts}x @ ${booking.blitz.staggerMs}ms]`
      : '';
    console.log(`   📅 ${booking.label || booking.restaurant}: fires in ${Math.round(delayMs / 1000)}s → ${booking.dates.join(', ')} at ${booking.time}${blitzLabel}`);
  } else {
    // Fall back to cron for recurring schedules
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

/** Remove a scheduled booking */
export function removeScheduledBooking(id: string): boolean {
  const entry = scheduledBookings.get(id);
  if (!entry) return false;
  entry.task.stop();
  scheduledBookings.delete(id);
  return true;
}

/** Get all scheduled bookings */
export function getScheduledBookings(): ScheduledBooking[] {
  return Array.from(scheduledBookings.values()).map(e => e.booking);
}

/** Add a manual booking result to history */
export function addToHistory(entry: BookingHistoryEntry): void {
  bookingHistory.unshift(entry);
  // Keep last 50 entries
  if (bookingHistory.length > 50) bookingHistory.length = 50;
}

/** Get booking history */
export function getHistory(): BookingHistoryEntry[] {
  return bookingHistory;
}

/** Delete a single history entry */
export function deleteHistoryEntry(id: string): boolean {
  const idx = bookingHistory.findIndex(e => e.id === id);
  if (idx < 0) return false;
  bookingHistory.splice(idx, 1);
  return true;
}

/** Clear all history */
export function clearHistory(): void {
  bookingHistory.length = 0;
}
