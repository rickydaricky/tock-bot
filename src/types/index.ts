export type Platform = 'tock' | 'opentable';

export interface TockPreferences {
  partySize: number;
  date: string; // Format: YYYY-MM-DD
  time: string; // Format: HH:MM
  // Auto-search settings
  autoSearchEnabled?: boolean;
  dropTime?: string; // ISO datetime string
  leadTimeMs?: number; // Milliseconds before drop time to search
  maxRetries?: number;
  retryIntervalSeconds?: number;
}

export interface Message {
  type: 'FILL_FORM' | 'FORM_FILLED' | 'ERROR' | 'AUTO_FILL_FORM' | 'FILL_RESULT' | 'CANCEL_TIMER' | 'GET_TIMER_STATUS' | 'TIMER_STATUS' | 'SCHEDULE_TIMER';
  payload?: any;
}

export interface ActiveTimer {
  alarmName: string;
  dropTime: string;
  scheduledTime: string; // When the alarm will fire (dropTime - leadTime)
  currentAttempt: number;
  maxRetries: number;
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