// server/src/engines.ts
import { runBooking as runTockBooking, BookingRequest, BookingResult } from './booker';
import { runOpenTableBooking } from './opentable/booker';
import type { Platform } from './cookies';

export function getBookingEngine(platform: Platform = 'tock'): {
  runBooking: (req: BookingRequest) => Promise<BookingResult>;
} {
  if (platform === 'opentable') return { runBooking: runOpenTableBooking };
  return { runBooking: runTockBooking };
}
