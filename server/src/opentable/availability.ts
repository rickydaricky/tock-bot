export interface OpenTableSlot { time24: string; time12: string; testid: string; }

/** Parse OpenTable slot button text like "6:00 PM*" into a normalized slot. */
export function parseSlots(raw: { testid: string; text: string }[]): OpenTableSlot[] {
  const out: OpenTableSlot[] = [];
  for (const { testid, text } of raw) {
    const m = (text || '').match(/(\d{1,2}):(\d{2})\s*(AM|PM)/i);
    if (!m) continue;
    let h = parseInt(m[1], 10);
    const min = parseInt(m[2], 10);
    const period = m[3].toUpperCase();
    if (period === 'PM' && h !== 12) h += 12;
    if (period === 'AM' && h === 12) h = 0;
    const time24 = `${String(h).padStart(2, '0')}:${String(min).padStart(2, '0')}`;
    out.push({ time24, time12: `${m[1]}:${m[2]} ${period}`, testid });
  }
  return out;
}

function toMinutes(t24: string): number {
  const [h, m] = t24.split(':').map(Number);
  return h * 60 + m;
}

/** Exact match on preferred 24h time, else the slot closest in minutes. */
export function pickBestSlot(slots: OpenTableSlot[], preferred24: string): OpenTableSlot | null {
  if (slots.length === 0) return null;
  const exact = slots.find((s) => s.time24 === preferred24);
  if (exact) return exact;
  const target = toMinutes(preferred24);
  return slots.reduce((best, s) =>
    Math.abs(toMinutes(s.time24) - target) < Math.abs(toMinutes(best.time24) - target) ? s : best
  );
}
