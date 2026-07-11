/**
 * sniper-config.ts — pure normalization of the sniper HTTP payload's T0-Volley-Fire fields.
 *
 * Single responsibility: turn the untyped `sniper` sub-object of an inbound /api/sniper or
 * /api/scheduled request into the (optional) subset of SniperConfig the volley engine reads,
 * with each field coerced to its declared shape or dropped to `undefined`. It lives in its own
 * module (rather than inline in index.ts) for one reason: index.ts runs `app.listen` as a side
 * effect and exports nothing, so its logic can't be unit-tested without booting Express — this
 * pure function can, and is (see test/sniper-config.test.ts).
 *
 * Both sniper entry points call this ONE helper so the two config-normalization blocks in
 * index.ts stay byte-identical for the volley fields (they are required to "stay in sync"), and
 * so a new volley field is added in exactly one place. Values are shape-coerced but NOT
 * range-clamped here — `validateSniperConfig` (sniper.ts) owns bounds and both routes call it
 * immediately after building the config, so a malformed value is rejected at request time.
 */
import { SniperConfig } from './sniper';

/** Number iff finite, else undefined (rejects NaN/Infinity/strings/objects). */
function numOrUndef(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

/** A non-empty array of strings, else undefined. Empty ⇒ undefined so it reads as "absent"
 *  (an empty wanted-list would otherwise look like an intentional "want nothing"). */
function strArrayOrUndef(v: unknown): string[] | undefined {
  return Array.isArray(v) && v.length > 0 && v.every(x => typeof x === 'string') ? (v as string[]) : undefined;
}

/** A non-empty array of finite numbers, else undefined (same empty-⇒-absent rule as above). */
function numArrayOrUndef(v: unknown): number[] | undefined {
  return Array.isArray(v) && v.length > 0 && v.every(x => typeof x === 'number' && Number.isFinite(x))
    ? (v as number[]) : undefined;
}

/**
 * Extract + coerce the T0-Volley-Fire fields (win-fhh-design §6 Task 12) from a raw sniper
 * payload into a `Partial<SniperConfig>` ready to spread onto a normalized config.
 *
 * Pass-through semantics: every field is optional and defaults to `undefined` when absent or
 * malformed, so nothing here can accidentally force a default ON. `volleyFire` engages only on
 * an exact `=== true` (a truthy string/number won't silently arm the volley engine); the rest
 * are advisory numbers/lists the engine range-checks and defaults for. Bounds live in
 * `validateSniperConfig`, not here.
 */
export function normalizeVolleyFields(sniper: Record<string, unknown> | undefined): Partial<SniperConfig> {
  if (!sniper) return {};
  return {
    volleyFire: sniper.volleyFire === true ? true : undefined,
    wantedTimes24: strArrayOrUndef(sniper.wantedTimes24),
    wantedDates: strArrayOrUndef(sniper.wantedDates),
    fireLeadMs: numOrUndef(sniper.fireLeadMs),
    reFireMs: numOrUndef(sniper.reFireMs),
    volleyDeadlineMs: numOrUndef(sniper.volleyDeadlineMs),
    fixedExperienceId: numOrUndef(sniper.fixedExperienceId),
    fixedPrepaidCents: numOrUndef(sniper.fixedPrepaidCents),
    fixedSeatingAreaId: numOrUndef(sniper.fixedSeatingAreaId),
    f6Candidates: numArrayOrUndef(sniper.f6Candidates),
  };
}
