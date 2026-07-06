// server/src/engines.ts
import { runBooking as runTockBooking, BookingRequest, BookingResult } from './booker';
import { runOpenTableBooking } from './opentable/booker';
import { runBlitz as runTockBlitz, BlitzConfig, BlitzResult } from './blitz';
import { runOpenTableBlitz } from './opentable/blitz';
import type { Platform } from './cookies';

export function getBookingEngine(platform: Platform = 'tock'): {
  runBooking: (req: BookingRequest) => Promise<BookingResult>;
  runBlitz: (req: BookingRequest, cfg: BlitzConfig, runAt?: string) => Promise<BlitzResult>;
} {
  if (platform === 'opentable') {
    return {
      runBooking: runOpenTableBooking,
      runBlitz: (req, cfg, runAt) => runOpenTableBlitz(req, cfg, runAt),
    };
  }
  return {
    runBooking: runTockBooking,
    runBlitz: (req, cfg, runAt) => runTockBlitz(req, cfg, runAt),
  };
}
