import { TockPreferences, ActiveTimer } from '../types';

// Default preferences
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
};

interface StorageResult {
  preferences?: TockPreferences;
  [key: string]: any;
}

// Save preferences to Chrome storage
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

// Load preferences from Chrome storage
export const loadPreferences = async (): Promise<TockPreferences> => {
  return new Promise((resolve) => {
    chrome.storage.sync.get(['preferences'], (result: StorageResult) => {
      resolve(result.preferences || DEFAULT_PREFERENCES);
    });
  });
};

// Save active timer state to Chrome storage
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

// Load active timer state from Chrome storage
export const loadActiveTimer = async (): Promise<ActiveTimer | null> => {
  return new Promise((resolve) => {
    chrome.storage.local.get(['activeTimer'], (result: StorageResult) => {
      resolve(result.activeTimer || null);
    });
  });
};

// Clear active timer state from Chrome storage
export const clearActiveTimer = async (): Promise<void> => {
  return saveActiveTimer(null);
}; 