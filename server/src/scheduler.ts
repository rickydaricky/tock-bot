import cron from 'node-cron';
import { runBooking, BookingRequest } from './booker';
import { notifyResult } from './notify';

interface ScheduledBooking extends BookingRequest {
  cron: string; // cron expression e.g. "0 10 1 4 *"
}

/** Start all scheduled booking cron jobs from SCHEDULED_BOOKINGS env var */
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
    if (!cron.validate(booking.cron)) {
      console.error(`Invalid cron expression: ${booking.cron} for ${booking.restaurant}`);
      continue;
    }

    cron.schedule(booking.cron, async () => {
      console.log(`\n⏰ Cron triggered for ${booking.restaurant}`);
      const result = await runBooking(booking);
      await notifyResult(booking.restaurant, result);
    });

    console.log(`   ${booking.restaurant}: "${booking.cron}" → ${booking.dates.join(', ')} at ${booking.time}`);
  }
}
