import { to12Hour } from './booker';

export interface NormalizedSlot {
  date: string;     // YYYY-MM-DD
  time12: string;   // e.g. "8:00 PM"
  offerId?: string; // offering id from availability, if present
}

/** Exact date+time match. No fuzzy fallback — sniper only grabs what was asked,
 *  so the first-available-time footgun from the old blitz can't surprise-charge. */
export function pickSlot(slots: NormalizedSlot[], date: string, time24: string): NormalizedSlot | null {
  const want = to12Hour(time24).toLowerCase();
  return slots.find(s => s.date === date && s.time12.toLowerCase() === want) ?? null;
}

/** Synchronous compare-and-set. JS is single-threaded, so a sync flag is a
 *  sufficient mutex across concurrent async poll loops: the first loop to find
 *  a slot wins, the rest get false and stop. Prevents duplicate grab/charge. */
export class SingleWinnerLock {
  private claimed = false;
  tryAcquire(): boolean {
    if (this.claimed) return false;
    this.claimed = true;
    return true;
  }
  get won(): boolean { return this.claimed; }
}

/** Evenly spread `pool` poll-loop START offsets across [windowStartMs, windowEndMs]
 *  inclusive (ms relative to runAt). Each loop then polls every pollIntervalMs until
 *  window end, so coverage overlaps and blankets the window. */
export function computeWindowOffsets(pool: number, windowStartMs: number, windowEndMs: number): number[] {
  const n = Math.max(1, pool);
  if (n === 1) return [windowStartMs];
  const span = windowEndMs - windowStartMs;
  return Array.from({ length: n }, (_, i) => windowStartMs + Math.round((span * i) / (n - 1)));
}

/** Normalize a Tock availability response into NormalizedSlot[].
 *  THE ONLY recon-dependent unit. The exact live shape is unconfirmed
 *  (see docs/superpowers/specs/2026-06-26-tock-api-recon.md): the real slot
 *  schema lives in Redux `availability.result`, capturable only live. This
 *  tolerates the shapes seen in saved pages and returns [] on anything
 *  unrecognized — the engine then falls back to reload-on-hit DOM scraping. */
export function parseAvailability(json: unknown): NormalizedSlot[] {
  const out: NormalizedSlot[] = [];
  const root: any = json;
  const days: any[] = Array.isArray(root?.availability) ? root.availability
    : Array.isArray(root?.days) ? root.days
    : [];
  for (const day of days) {
    const date = day?.date ?? day?.businessDate;
    const offers: any[] = Array.isArray(day?.offers) ? day.offers
      : Array.isArray(day?.times) ? day.times
      : [];
    for (const o of offers) {
      const time12 = o?.time ?? o?.display ?? o?.label;
      if (date && time12) {
        out.push({ date: String(date), time12: String(time12), offerId: o?.id ?? o?.offerId });
      }
    }
  }
  return out;
}
