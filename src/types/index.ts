export type Platform = 'tock' | 'opentable' | 'resy';

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
  leadTimeMs?: number; // Milliseconds before drop time to search (positive = before, negative = after)
  // Auto-refresh settings
  autoRefreshOnNoSlots?: boolean; // Auto-refresh if no slots found (default: false)
  maxRefreshRetries?: number; // Number of refresh attempts (default: 3)
  // Timing measurement
  alarmFireTime?: number; // Timestamp when alarm fired (for performance measurement)
}

export interface Message {
  type: 'FILL_FORM' | 'FORM_FILLED' | 'ERROR' | 'AUTO_FILL_FORM' | 'FILL_RESULT' | 'CANCEL_TIMER' | 'GET_TIMER_STATUS' | 'TIMER_STATUS' | 'SCHEDULE_TIMER' | 'CLICK_RESERVE_BUTTON';
  payload?: any;
}

export interface ActiveTimer {
  alarmName: string;
  dropTime: string;
  scheduledTime: string; // When the alarm will fire (dropTime - leadTime)
  status: 'scheduled' | 'running' | 'completed' | 'failed' | 'cancelled';
  tabId?: number; // The tab where the reservation should happen
}

export interface FormElements {
  partySize?: HTMLElement;
  dateButton?: HTMLElement;
  timeSelect?: HTMLSelectElement;
  searchButton?: HTMLElement;
  bookButton?: HTMLElement;
}

export interface FormFillerOptions {
  preferences: TockPreferences;
  waitForForm?: boolean;
  autoSubmit?: boolean;
} 