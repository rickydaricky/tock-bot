// This is the background script for the Tock Reservation Form Filler extension
import { Message, TockPreferences, ActiveTimer } from '../types';
import { DEFAULT_PREFERENCES, saveActiveTimer, loadActiveTimer, clearActiveTimer, loadPreferences } from '../utils/storage';
import { sendAutoFillFormMessage } from '../utils/messaging';
import { detectPlatform } from '../utils/platform';
import { buildTockSearchUrl, buildTockSearchUrlWithDate } from '../utils/url-builder';

console.log('Tock Form Filler Background Script Loaded');

/**
 * Build the complete list of desired dates to try
 * Returns array of date strings in YYYY-MM-DD format
 */
function buildDesiredDatesList(preferences: TockPreferences): string[] {
  const desiredDates: string[] = [];

  // Start with primary date
  desiredDates.push(preferences.date);
  console.log(`[Date List] Primary date: ${preferences.date}`);

  // Check if specific dates are selected via calendar (this overrides auto-scan range)
  const selectedDates = preferences.selectedDates || [];
  if (selectedDates.length > 0) {
    console.log(`[Date List] Using ${selectedDates.length} specific calendar-selected dates (overriding auto-scan range)`);
    // Add selected dates (skip duplicates)
    for (const date of selectedDates) {
      if (!desiredDates.includes(date)) {
        desiredDates.push(date);
      }
    }
  }
  // Otherwise, use auto-scan range if enabled
  else if (preferences.useFirstAvailableAfter) {
    const maxDaysToScan = preferences.maxDaysToScan ?? 7;
    console.log(`[Date List] Auto-scan enabled, scanning ±${maxDaysToScan} days from primary`);

    const primaryDate = new Date(preferences.date);

    // Scan both before and after primary date
    for (let dayOffset = -maxDaysToScan; dayOffset <= maxDaysToScan; dayOffset++) {
      if (dayOffset === 0) continue; // Skip primary date (already added)

      const scanDate = new Date(primaryDate);
      scanDate.setDate(primaryDate.getDate() + dayOffset);
      const scanDateString = scanDate.toISOString().split('T')[0];

      if (!desiredDates.includes(scanDateString)) {
        desiredDates.push(scanDateString);
      }
    }
  }

  console.log(`[Date List] Built list of ${desiredDates.length} desired dates: ${desiredDates.join(', ')}`);
  return desiredDates;
}

const ALARM_NAME_PREFIX = 'tock-auto-search';

// Listen for installation
chrome.runtime.onInstalled.addListener((details) => {
  if (details.reason === 'install') {
    console.log('Extension installed');
    // Initialize default settings
    chrome.storage.sync.set({
      preferences: DEFAULT_PREFERENCES
    }, () => {
      console.log('Default preferences saved');
    });
  }
});

// Restore active timer on startup (e.g., after browser restart)
chrome.runtime.onStartup.addListener(async () => {
  console.log('Extension startup - checking for active timers');
  const activeTimer = await loadActiveTimer();

  if (activeTimer && activeTimer.status === 'scheduled') {
    const alarms = await chrome.alarms.getAll();
    const hasAlarm = alarms.some(alarm => alarm.name === activeTimer.alarmName);

    if (!hasAlarm) {
      // Alarm was lost, recreate it if still in the future
      const scheduledTime = new Date(activeTimer.scheduledTime).getTime();
      const now = Date.now();

      if (scheduledTime > now) {
        const delayInMinutes = (scheduledTime - now) / 1000 / 60;
        await chrome.alarms.create(activeTimer.alarmName, { delayInMinutes });
        console.log('Recreated alarm:', activeTimer.alarmName);
      } else {
        // Timer is in the past, clean it up
        await clearActiveTimer();
        console.log('Cleared expired timer');
      }
    }
  }
});

// Listen for alarms
chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name.startsWith(ALARM_NAME_PREFIX)) {
    console.log('Alarm triggered:', alarm.name);
    await handleAlarmTrigger(alarm.name);
  }
});

// Handle alarm trigger - execute the form filling
async function handleAlarmTrigger(alarmName: string) {
  const alarmFireTime = Date.now();
  console.log(`⏰ [TIMING] Alarm fired at: ${new Date(alarmFireTime).toISOString()}`);

  const activeTimer = await loadActiveTimer();

  if (!activeTimer || activeTimer.alarmName !== alarmName) {
    console.error('No active timer found for alarm:', alarmName);
    return;
  }

  // Update status to running
  activeTimer.status = 'running';
  await saveActiveTimer(activeTimer);

  try {
    // Get preferences
    const preferences = await loadPreferences();

    // Add alarm fire time to preferences for timing measurement
    preferences.alarmFireTime = alarmFireTime;

    // Build list of desired dates to try
    const desiredDates = buildDesiredDatesList(preferences);

    const backgroundProcessingTime = Date.now();
    console.log(`⏰ [TIMING] Background processing complete (delta: ${(backgroundProcessingTime - alarmFireTime).toFixed(2)}ms)`);

    // Attempt to fill the form on the target tab
    if (activeTimer.tabId) {
      const result = await attemptFormFill(activeTimer.tabId, preferences, desiredDates);

      if (result.success) {
        // Success! Mark as completed
        activeTimer.status = 'completed';
        await saveActiveTimer(activeTimer);
        console.log(`✅ Successfully booked!`);
      } else {
        // Failed
        activeTimer.status = 'failed';
        await saveActiveTimer(activeTimer);
        console.log('❌ Failed to book any available dates');
      }
    } else {
      // No tab ID, mark as failed
      activeTimer.status = 'failed';
      await saveActiveTimer(activeTimer);
      console.error('No tab ID specified for timer');
    }
  } catch (error) {
    console.error('Error executing auto-fill:', error);
    activeTimer.status = 'failed';
    await saveActiveTimer(activeTimer);
  }
}

// Wait for a tab to finish reloading
async function waitForTabReload(tabId: number): Promise<void> {
  return new Promise((resolve) => {
    const listener = (updatedTabId: number, changeInfo: chrome.tabs.TabChangeInfo) => {
      if (updatedTabId === tabId && changeInfo.status === 'complete') {
        chrome.tabs.onUpdated.removeListener(listener);
        // Add a small buffer delay for stability
        setTimeout(() => resolve(), 150);
      }
    };
    chrome.tabs.onUpdated.addListener(listener);
  });
}

// Attempt to fill the form manually (for user-initiated fills)
// Similar to attemptFormFill but WITHOUT the refresh step
async function attemptManualFormFill(tabId: number, preferences: TockPreferences, desiredDates: string[]): Promise<{ success: boolean }> {
  try {
    // Get the tab to check its URL
    const tab = await chrome.tabs.get(tabId);

    if (!tab.url) {
      console.error('Tab URL not available');
      return { success: false };
    }

    // Check if this is a Tock page
    const platform = detectPlatform(tab.url);

    if (platform === 'tock') {
      console.log(`🔄 Manual fill - Tock platform detected, navigating to search page`);
      const navigateStartTime = Date.now();

      // Build search URL with the PRIMARY date (first in list)
      const primaryDate = desiredDates[0];
      const searchUrl = buildTockSearchUrlWithDate(tab.url, preferences, primaryDate);

      if (!searchUrl) {
        console.error('Failed to build Tock search URL');
        return { success: false };
      }

      console.log(`🔗 Navigating to: ${searchUrl}`);

      // Navigate to the search URL
      await chrome.tabs.update(tabId, { url: searchUrl });

      // Wait for the page to finish loading
      await waitForTabReload(tabId);

      const navigateEndTime = Date.now();
      console.log(`⏰ [TIMING] Navigation completed (delta: ${navigateEndTime - navigateStartTime}ms)`);

      // Send message with desired dates list for content script to try
      console.log(`📅 Sending ${desiredDates.length} desired dates to content script`);
      const result = await chrome.tabs.sendMessage(tabId, {
        type: 'AUTO_FILL_FORM',
        payload: {
          preferences,
          datesToTry: desiredDates,
        }
      });

      return { success: result.success };
    } else {
      // For non-Tock platforms, use original single-date behavior
      const result = await sendAutoFillFormMessage(preferences, tabId);
      return result;
    }
  } catch (error) {
    console.error('Error sending manual fill message:', error);
    return { success: false };
  }
}

// Attempt to fill the form on a specific tab with multiple dates (for scheduled automatic fills)
// Includes a refresh to get fresh data from the server at drop time
async function attemptFormFill(tabId: number, preferences: TockPreferences, desiredDates: string[]): Promise<{ success: boolean }> {
  try {
    // Get the tab to check its URL
    const tab = await chrome.tabs.get(tabId);

    if (!tab.url) {
      console.error('Tab URL not available');
      return { success: false };
    }

    // Check if this is a Tock page
    const platform = detectPlatform(tab.url);

    if (platform === 'tock') {
      console.log(`🔄 Tock platform detected - page already on search URL, refreshing for fresh data`);
      const reloadStartTime = Date.now();

      // Refresh the page to get fresh data from server
      // (Page is already on search URL thanks to scheduleTimer navigation)
      console.log('🔄 Refreshing page to fetch fresh availability data');
      await chrome.tabs.reload(tabId);

      // Wait for the refresh to complete
      await waitForTabReload(tabId);

      const reloadEndTime = Date.now();
      console.log(`⏰ [TIMING] Page refresh completed (delta: ${reloadEndTime - reloadStartTime}ms)`);

      // Send message with desired dates list for content script to try
      console.log(`📅 Sending ${desiredDates.length} desired dates to content script`);
      const result = await chrome.tabs.sendMessage(tabId, {
        type: 'AUTO_FILL_FORM',
        payload: {
          preferences,
          datesToTry: desiredDates,
        }
      });

      return { success: result.success };
    } else {
      // For non-Tock platforms, use original single-date behavior
      const result = await sendAutoFillFormMessage(preferences, tabId);
      return result;
    }
  } catch (error) {
    console.error('Error sending auto-fill message:', error);
    return { success: false };
  }
}

// Schedule a new timer
async function scheduleTimer(preferences: TockPreferences, tabId: number): Promise<ActiveTimer> {
  // Clear any existing timer
  await cancelTimer();

  if (!preferences.dropTime) {
    throw new Error('Drop time not specified');
  }

  const dropTime = new Date(preferences.dropTime);
  const leadTimeMs = preferences.leadTimeMs || 200;
  const scheduledTime = new Date(dropTime.getTime() - leadTimeMs);
  const now = new Date();

  if (scheduledTime <= now) {
    throw new Error('Scheduled time is in the past');
  }

  // Create alarm name with timestamp
  const alarmName = `${ALARM_NAME_PREFIX}-${Date.now()}`;

  // Calculate delay in minutes for chrome.alarms
  const delayInMinutes = (scheduledTime.getTime() - now.getTime()) / 1000 / 60;

  // Create the alarm
  await chrome.alarms.create(alarmName, { delayInMinutes });

  // Create timer state
  const timer: ActiveTimer = {
    alarmName,
    dropTime: dropTime.toISOString(),
    scheduledTime: scheduledTime.toISOString(),
    currentAttempt: 0,
    maxRetries: preferences.maxRetries ?? 0,
    status: 'scheduled',
    tabId,
  };

  await saveActiveTimer(timer);
  console.log('Timer scheduled:', timer);

  // For Tock: Navigate to search URL immediately so page is ready for refresh
  try {
    const tab = await chrome.tabs.get(tabId);
    if (tab.url) {
      const platform = detectPlatform(tab.url);

      if (platform === 'tock') {
        const searchUrl = buildTockSearchUrl(tab.url, preferences);

        if (searchUrl) {
          console.log('🔗 Navigating to Tock search URL:', searchUrl);
          await chrome.tabs.update(tabId, { url: searchUrl });
        } else {
          console.warn('Failed to build Tock search URL, will use form filling approach');
        }
      }
      // For OpenTable: Do nothing, keep current behavior
    }
  } catch (error) {
    console.error('Error navigating to search URL:', error);
    // Continue anyway - form filler will handle it
  }

  return timer;
}

// Cancel the active timer
async function cancelTimer(): Promise<void> {
  const activeTimer = await loadActiveTimer();

  if (activeTimer) {
    // Clear the alarm
    await chrome.alarms.clear(activeTimer.alarmName);

    // Update status
    activeTimer.status = 'cancelled';
    await saveActiveTimer(activeTimer);

    // Clear from storage
    setTimeout(() => clearActiveTimer(), 1000);

    console.log('Timer cancelled:', activeTimer.alarmName);
  }
}

// Get current timer status
async function getTimerStatus(): Promise<ActiveTimer | null> {
  return await loadActiveTimer();
}

// Listen for messages from popup
chrome.runtime.onMessage.addListener((message: Message, sender, sendResponse) => {
  console.log('Background received message:', message);

  if (message.type === 'CANCEL_TIMER') {
    cancelTimer()
      .then(() => sendResponse({ success: true }))
      .catch(error => sendResponse({ success: false, error: error.message }));
    return true; // Keep channel open for async response
  }

  if (message.type === 'GET_TIMER_STATUS') {
    getTimerStatus()
      .then(status => sendResponse(status))
      .catch(error => {
        console.error('Error getting timer status:', error);
        sendResponse(null);
      });
    return true; // Keep channel open for async response
  }

  // Handle schedule timer request from popup
  if (message.type === 'SCHEDULE_TIMER') {
    const { preferences, tabId } = message.payload;
    scheduleTimer(preferences, tabId)
      .then(timer => sendResponse({ success: true, timer }))
      .catch(error => sendResponse({ success: false, error: error.message }));
    return true; // Keep channel open for async response
  }

  // Handle manual fill form request from popup
  if (message.type === 'FILL_FORM') {
    const { preferences, tabId } = message.payload;

    // Build list of desired dates to try
    const desiredDates = buildDesiredDatesList(preferences);

    attemptManualFormFill(tabId, preferences, desiredDates)
      .then(result => sendResponse(result))
      .catch(error => sendResponse({ success: false, error: error.message }));
    return true; // Keep channel open for async response
  }
});

// The background script handles events and actions that need to persist
// beyond the lifecycle of the popup
