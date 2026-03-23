import cron from 'node-cron';
import { runBooking, BookingRequest } from './booker';
import { notifyResult } from './notify';

export interface ScheduledBooking extends BookingRequest {
  id: string;
  cron: string;          // cron expression e.g. "0 10 1 4 *"
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
}

const scheduledBookings: Map<string, { booking: ScheduledBooking; task: cron.ScheduledTask }> = new Map();
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

/** Add a scheduled booking and start its cron job */
export function addScheduledBooking(booking: ScheduledBooking): { success: boolean; error?: string } {
  if (!booking.id) booking.id = crypto.randomUUID();
  if (!booking.createdAt) booking.createdAt = new Date().toISOString();

  if (!cron.validate(booking.cron)) {
    return { success: false, error: `Invalid cron expression: ${booking.cron}` };
  }

  // Stop existing task if updating
  if (scheduledBookings.has(booking.id)) {
    scheduledBookings.get(booking.id)!.task.stop();
  }

  const task = cron.schedule(booking.cron, async () => {
    console.log(`\n⏰ Cron triggered: ${booking.label || booking.restaurant}`);
    const result = await runBooking(booking);
    await notifyResult(booking.restaurant, result);

    bookingHistory.unshift({
      id: crypto.randomUUID(),
      restaurant: booking.restaurant,
      date: result.bookedDate,
      time: result.bookedTime,
      success: result.success,
      error: result.error,
      screenshots: result.screenshots,
      ranAt: new Date().toISOString(),
      source: 'scheduled',
    });
  });

  scheduledBookings.set(booking.id, { booking, task });
  console.log(`   📅 ${booking.label || booking.restaurant}: "${booking.cron}" → ${booking.dates.join(', ')} at ${booking.time}`);
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
