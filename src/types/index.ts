/**
 * Shared TypeScript type definitions for the Chrome extension half of tock-bot.
 *
 * Responsibility: the single source of truth for the data shapes exchanged
 * between the extension's moving parts — popup UI, background service worker,
 * and the per-platform content scripts (Tock/OpenTable/Resy form-fillers).
 * These types describe user-configured booking preferences, the message
 * protocol used for cross-context communication, and the DOM handles the
 * form-fillers collect.
 *
 * Key exports:
 *  - `Platform`          — the reservation site a booking targets.
 *  - `TockPreferences`   — the full user config persisted in extension storage
 *                          (party/date/time + auto-search/refresh/purchase).
 *  - `Message`           — the tagged-union envelope for runtime messaging.
 *  - `ActiveTimer`       — bookkeeping for a scheduled drop-time alarm.
 *  - `FormElements`      — cached references to the Tock search-form DOM nodes.
 *  - `FormFillerOptions` — inputs to a form-filler run.
 */

/**
 * Which reservation platform a booking targets. Selects the content script and
 * URL/selectors used; Tock is the primary/sniper target, OpenTable and Resy are
 * best-effort form-fill support.
 */
export type Platform = 'tock' | 'opentable' | 'resy';

/**
 * The complete user-configured booking profile persisted in Chrome extension
 * storage and passed to the content scripts. Only `partySize`, `date`, and
 * `time` are required — everything else tunes optional auto-search,
 * auto-refresh, and auto-purchase behavior. String formats are load-bearing:
 * dates are `YYYY-MM-DD` and times `HH:MM` because they are fed directly into
 * Tock's date/time widgets.
 */
export interface TockPreferences {
  partySize: number;
  date: string; // Format: YYYY-MM-DD
  time: string; // Format: HH:MM
  // Fallback date settings
  fallbackDates?: string[]; // Array of dates in YYYY-MM-DD format
  useFirstAvailableAfter?: boolean; // Auto-scan around primary date (±N days)
  dateSelectionMode?: 'range' | 'specific'; // Toggle between range scanning or specific date selection
  maxDaysToScan?: number; // Days to scan before/after primary (default: 7)
  selectedDates?: string[]; // Specific dates selected via calendar (overrides auto-scan range)
  // Auto-search settings
  autoSearchEnabled?: boolean;
  dropTime?: string; // ISO datetime string
  // Offset applied to `dropTime` to decide when to actually fire the search.
  // Sign convention is deliberate and easy to get wrong: positive fires
  // BEFORE the drop (front-runs it), negative fires AFTER.
  leadTimeMs?: number; // Milliseconds before drop time to search (positive = before, negative = after)
  // Auto-refresh settings
  autoRefreshOnNoSlots?: boolean; // Auto-refresh if no slots found (default: false)
  maxRefreshRetries?: number; // Number of refresh attempts (default: 3)
  // Timing measurement
  alarmFireTime?: number; // Timestamp when alarm fired (for performance measurement)
  // Auto-purchase settings
  // NOTE: card/billing fields below are stored in extension storage in
  // plaintext and forwarded to the local card-automation server; they are the
  // fallback source when the popup UI doesn't supply them at purchase time.
  autoPurchaseEnabled?: boolean; // Enable auto-purchase flow after booking
  cardNumber?: string; // Credit card number for auto-purchase
  cardExpiry?: string; // Card expiry MM/YY for auto-purchase
  cvc?: string; // CVC code for auto-purchase
  billingName?: string; // Full name on card
  billingAddress?: string; // Address line 1
  billingCity?: string; // City
  billingState?: string; // State (2-letter code e.g. CA)
  billingZip?: string; // ZIP code
  maxPriceCents?: number; // OpenTable fail-closed cap on any upfront charge
}

/**
 * The envelope for all `chrome.runtime`/`chrome.tabs` messaging between the
 * popup, background service worker, and content scripts. `type` is the
 * discriminant that tells the receiver how to interpret `payload`; `payload` is
 * intentionally untyped (`any`) because each `type` carries a different shape
 * and the extension has no shared schema per message kind.
 */
export interface Message {
  type: 'FILL_FORM' | 'FORM_FILLED' | 'ERROR' | 'AUTO_FILL_FORM' | 'FILL_RESULT' | 'CANCEL_TIMER' | 'GET_TIMER_STATUS' | 'TIMER_STATUS' | 'SCHEDULE_TIMER' | 'CLICK_RESERVE_BUTTON';
  payload?: any;
}

/**
 * Bookkeeping for a single scheduled drop-time countdown, tracked by the
 * background worker and surfaced to the popup/floating-timer UI. Backed by a
 * `chrome.alarms` alarm named `alarmName`; `status` follows the lifecycle
 * scheduled → running → (completed | failed | cancelled).
 */
export interface ActiveTimer {
  alarmName: string;
  dropTime: string;
  scheduledTime: string; // When the alarm will fire (dropTime - leadTime)
  status: 'scheduled' | 'running' | 'completed' | 'failed' | 'cancelled';
  tabId?: number; // The tab where the reservation should happen
}

/**
 * Cached handles to the Tock search-form controls a content script has located
 * in the page DOM. All fields are optional because the form is discovered
 * incrementally — the elements appear at different render stages, and some
 * (e.g. `bookButton`) only exist once results are shown, so callers must
 * null-check before using each one.
 */
export interface FormElements {
  partySize?: HTMLElement;
  dateButton?: HTMLElement;
  timeSelect?: HTMLSelectElement;
  searchButton?: HTMLElement;
  bookButton?: HTMLElement;
}

/**
 * Inputs to a single form-filler run. `preferences` supplies what to fill;
 * `waitForForm` makes the filler poll for the form to render before acting
 * (needed on slow/SPA loads), and `autoSubmit` decides whether it clicks
 * search/book itself or leaves the user to confirm.
 */
export interface FormFillerOptions {
  preferences: TockPreferences;
  waitForForm?: boolean;
  autoSubmit?: boolean;
} 