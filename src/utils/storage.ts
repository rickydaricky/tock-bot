/**
 * chrome.storage wrappers for the Chrome extension's persisted state.
 *
 * Single responsibility: promisify Chrome's callback-based storage API and
 * centralize where each piece of extension state lives, so the rest of the
 * extension never touches `chrome.storage` directly.
 *
 * Two storage areas are used deliberately, each with different semantics:
 *  - `chrome.storage.sync`  — user preferences (party size, date, drop time,
 *    auto-purchase toggle). Syncs across the user's signed-in Chrome instances
 *    but has a small per-item quota (~8KB). Kept for durable, portable config.
 *  - `chrome.storage.local` — the active countdown timer. Device-local, larger
 *    quota, and transient — the timer is tied to the machine actually running
 *    the sniper, so it must NOT roam to other devices.
 *
 * Key exports:
 *  - DEFAULT_PREFERENCES        — fallback config used on first run / cold storage
 *  - savePreferences / loadPreferences   — persist & read TockPreferences (sync)
 *  - saveActiveTimer / loadActiveTimer   — persist & read ActiveTimer (local)
 *  - clearActiveTimer           — remove the active timer
 */
import { TockPreferences, ActiveTimer } from '../types';

/**
 * Baseline preferences returned whenever storage is empty (first run, or the
 * `preferences` key was never written). Every field mirrors a control in the
 * popup UI; the values here are the "safe defaults" that keep destructive
 * automation OFF until the user explicitly opts in.
 *
 * Note: `date` is computed at module-load time, so it reflects the day the
 * extension context started rather than a truly live "today".
 */
export const DEFAULT_PREFERENCES: TockPreferences = {
  partySize: 2,
  date: new Date().toISOString().split('T')[0], // Today's date in YYYY-MM-DD format
  time: '12:00', // Default to noon
  useFirstAvailableAfter: false, // Auto-scan disabled by default
  maxDaysToScan: 7, // Default to scanning ±7 days around primary date
  selectedDates: [], // No specific dates selected by default
  autoSearchEnabled: false,
  dropTime: undefined,
  leadTimeMs: 0, // Refresh exactly at drop time (not before, to ensure fresh data)
  autoPurchaseEnabled: false, // Auto-purchase flow disabled by default
};

/**
 * Loose shape for the object Chrome's `storage.get` hands back. The index
 * signature is required because a single `get` may pull unrelated keys, and
 * Chrome types the result as a generic bag rather than our concrete types.
 */
interface StorageResult {
  preferences?: TockPreferences;
  [key: string]: any;
}

/**
 * Persist user preferences to `chrome.storage.sync`.
 *
 * Wraps the callback-based API in a Promise and surfaces write failures:
 * unlike the loaders below, this REJECTS on `chrome.runtime.lastError` (e.g.
 * sync quota exceeded) so callers can detect a failed save rather than
 * silently believing config was stored.
 */
export const savePreferences = async (preferences: TockPreferences): Promise<void> => {
  return new Promise((resolve, reject) => {
    chrome.storage.sync.set({ preferences }, () => {
      if (chrome.runtime.lastError) {
        reject(chrome.runtime.lastError);
      } else {
        resolve();
      }
    });
  });
};

/**
 * Read user preferences from `chrome.storage.sync`, falling back to
 * DEFAULT_PREFERENCES when the key is absent.
 *
 * Intentionally never rejects: a read failure resolves to defaults so the
 * popup always has a usable config to render. Note the fallback is whole-object
 * — there is no per-field merge, so a partially-written `preferences` object
 * would surface as-is (missing fields undefined) rather than being backfilled.
 */
export const loadPreferences = async (): Promise<TockPreferences> => {
  return new Promise((resolve) => {
    chrome.storage.sync.get(['preferences'], (result: StorageResult) => {
      resolve(result.preferences || DEFAULT_PREFERENCES);
    });
  });
};

/**
 * Persist the active countdown timer to `chrome.storage.local` (device-local,
 * see file header for why this is NOT synced).
 *
 * Passing `null` clears the timer — this is the primitive `clearActiveTimer`
 * builds on. Rejects on `chrome.runtime.lastError` so a failed write is visible.
 */
export const saveActiveTimer = async (timer: ActiveTimer | null): Promise<void> => {
  return new Promise((resolve, reject) => {
    chrome.storage.local.set({ activeTimer: timer }, () => {
      if (chrome.runtime.lastError) {
        reject(chrome.runtime.lastError);
      } else {
        resolve();
      }
    });
  });
};

/**
 * Read the active countdown timer from `chrome.storage.local`.
 *
 * Resolves to `null` when no timer is stored (the same value used to represent
 * "no active timer"), and — like loadPreferences — never rejects so callers
 * can treat a read failure as simply "no timer running".
 */
export const loadActiveTimer = async (): Promise<ActiveTimer | null> => {
  return new Promise((resolve) => {
    chrome.storage.local.get(['activeTimer'], (result: StorageResult) => {
      resolve(result.activeTimer || null);
    });
  });
};

/**
 * Clear the active countdown timer. Thin alias over `saveActiveTimer(null)` so
 * call sites read intent-first ("stop the timer") without hard-coding `null`.
 */
export const clearActiveTimer = async (): Promise<void> => {
  return saveActiveTimer(null);
};

/** Signals the /booking/details content script to auto-complete an in-progress OpenTable auto-book. */
export interface OtBookingFlag { until: number; maxPriceCents?: number; }

export async function setOtBookingFlag(flag: OtBookingFlag): Promise<void> {
  await chrome.storage.local.set({ otBooking: flag });
}
export async function getOtBookingFlag(): Promise<OtBookingFlag | null> {
  const { otBooking } = await chrome.storage.local.get('otBooking');
  return (otBooking as OtBookingFlag) ?? null;
}
export async function clearOtBookingFlag(): Promise<void> {
  await chrome.storage.local.remove('otBooking');
}

/** Shape for the remote booking server config (URL + API key). */
export interface ServerConfig { url: string; key: string; }

/**
 * Persist the server config (URL + API key) to `chrome.storage.local`.
 * Device-local: the server URL is machine-specific, not worth roaming.
 */
export async function saveServerConfig(cfg: ServerConfig): Promise<void> {
  await chrome.storage.local.set({ serverConfig: cfg });
}

/**
 * Read the server config from `chrome.storage.local`.
 * Returns null when no config has been saved yet.
 */
export async function loadServerConfig(): Promise<ServerConfig | null> {
  const { serverConfig } = await chrome.storage.local.get('serverConfig');
  return serverConfig ?? null;
} 