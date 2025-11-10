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
  console.log(`🔔 [DEBUG] Alarm listener triggered for: ${alarm.name}`);
  if (alarm.name.startsWith(ALARM_NAME_PREFIX)) {
    console.log(`✅ [DEBUG] Alarm matches prefix, calling handleAlarmTrigger`);
    await handleAlarmTrigger(alarm.name);
    console.log(`✅ [DEBUG] handleAlarmTrigger completed`);
  } else {
    console.log(`⚠️ [DEBUG] Alarm does not match prefix, ignoring`);
  }
});

// Handle alarm trigger - execute the form filling
async function handleAlarmTrigger(alarmName: string) {
  const alarmFireTime = Date.now();
  console.log(`⏰ [TIMING] Alarm fired at: ${new Date(alarmFireTime).toISOString()}`);

  const activeTimer = await loadActiveTimer();

  if (!activeTimer || activeTimer.alarmName !== alarmName) {
    console.error(`❌ [DEBUG] No active timer found for alarm: ${alarmName}`);
    console.error(`   Active timer:`, activeTimer);
    return;
  }
  console.log(`✅ [DEBUG] Active timer found:`, activeTimer);

  // Update status to running
  console.log(`🔄 [DEBUG] Updating timer status from '${activeTimer.status}' to 'running'`);
  activeTimer.status = 'running';
  await saveActiveTimer(activeTimer);
  console.log(`✅ [DEBUG] Timer status updated to 'running'`);


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
      console.log(`🎯 [DEBUG] Calling attemptFormFill for tab ${activeTimer.tabId}`);
      const result = await attemptFormFill(activeTimer.tabId, preferences, desiredDates);
      console.log(`📊 [DEBUG] attemptFormFill returned:`, result);

      if (result.success) {
        // Success! Mark as completed
        console.log(`✅ [DEBUG] Form fill succeeded, updating status to 'completed'`);
        activeTimer.status = 'completed';
        await saveActiveTimer(activeTimer);
        console.log(`✅ [DEBUG] Status saved as 'completed'`);
        console.log(`✅ Successfully booked!`);
      } else {
        // Failed
        console.log(`❌ [DEBUG] Form fill failed, updating status to 'failed'`);
        activeTimer.status = 'failed';
        await saveActiveTimer(activeTimer);
        console.log(`✅ [DEBUG] Status saved as 'failed'`);
        console.log('❌ Failed to book any available dates');
      }
    } else {
      // No tab ID, mark as failed
      console.error(`❌ [DEBUG] No tab ID specified for timer`);
      activeTimer.status = 'failed';
      await saveActiveTimer(activeTimer);
      console.error('No tab ID specified for timer');
    }
  } catch (error) {
    console.error(`💥 [DEBUG] Exception caught in handleAlarmTrigger:`, error);
    console.error(`   Error type: ${error instanceof Error ? error.constructor.name : typeof error}`);
    console.error(`   Error message: ${error instanceof Error ? error.message : String(error)}`);
    console.error(`   Stack trace:`, error instanceof Error ? error.stack : 'N/A');
    activeTimer.status = 'failed';
    await saveActiveTimer(activeTimer);
    console.log(`✅ [DEBUG] Status saved as 'failed' after exception`);
  }
}

// Wait for a tab to finish reloading
async function waitForTabReload(tabId: number): Promise<void> {
  return new Promise((resolve, reject) => {
    console.log(`⏳ [DEBUG] waitForTabReload: Setting up listener for tab ${tabId}`);

    let completed = false;
    const timeout = setTimeout(() => {
      if (!completed) {
        completed = true;
        chrome.tabs.onUpdated.removeListener(listener);
        console.error(`❌ [DEBUG] waitForTabReload: Timeout after 5s`);
        reject(new Error('Tab reload timeout after 5 seconds'));
      }
    }, 5000); // 5 second timeout

    const listener = (updatedTabId: number, changeInfo: chrome.tabs.TabChangeInfo) => {
      console.log(`📡 [DEBUG] Tab update event: tab ${updatedTabId}, status: ${changeInfo.status}`);

      if (updatedTabId === tabId && changeInfo.status === 'complete') {
        if (!completed) {
          completed = true;
          clearTimeout(timeout);
          chrome.tabs.onUpdated.removeListener(listener);
          console.log(`✅ [DEBUG] waitForTabReload: Tab ${tabId} completed loading`);
          // Add a small buffer delay for stability
          setTimeout(() => resolve(), 150);
        }
      }
    };

    chrome.tabs.onUpdated.addListener(listener);
    console.log(`✅ [DEBUG] waitForTabReload: Listener attached`);
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
    console.log(`📑 [DEBUG] Tab info:`, { id: tab.id, url: tab.url, status: tab.status });

    if (!tab.url) {
      console.error(`❌ [DEBUG] Tab URL not available, returning failure`);
      return { success: false };
    }
    console.log(`✅ [DEBUG] Tab URL available: ${tab.url}`);

    // Check if this is a Tock page
    const platform = detectPlatform(tab.url);

    if (platform === 'tock') {
      console.log(`🔄 Tock platform detected - page already on search URL, refreshing for fresh data`);
      const reloadStartTime = Date.now();

      // Refresh the page to get fresh data from server
      // (Page is already on search URL thanks to scheduleTimer navigation)
      console.log('🔄 Refreshing page to fetch fresh availability data');
      console.log(`🔄 [DEBUG] Starting page reload for tab ${tabId}`);
      console.log(`   Current URL: ${tab.url}`);
      try {
        await chrome.tabs.reload(tabId);
        console.log(`✅ [DEBUG] Reload command sent successfully`);
      } catch (reloadError) {
        console.error(`❌ [DEBUG] Reload command failed:`, reloadError);
        throw reloadError;
      }

      // Wait for the refresh to complete
      console.log(`⏳ [DEBUG] Waiting for tab to finish reloading...`);
      try {
        await waitForTabReload(tabId);
        console.log(`✅ [DEBUG] Tab reload completed`);
      } catch (waitError) {
        console.error(`❌ [DEBUG] Wait for reload failed:`, waitError);
        throw waitError;
      }

      const reloadEndTime = Date.now();
      console.log(`⏰ [TIMING] Page refresh completed (delta: ${reloadEndTime - reloadStartTime}ms)`);

      // Send message with desired dates list for content script to try
      console.log(`📅 Sending ${desiredDates.length} desired dates to content script`);
      console.log(`📤 [DEBUG] Sending AUTO_FILL_FORM message to content script`);
      console.log(`   Tab ID: ${tabId}`);
      console.log(`   Dates to try: ${desiredDates.join(', ')}`);

      try {
        const result = await chrome.tabs.sendMessage(tabId, {
          type: 'AUTO_FILL_FORM',
          payload: {
            preferences,
            datesToTry: desiredDates,
          }
        });
        console.log(`📥 [DEBUG] Received response from content script:`, result);
        return { success: result.success };
      } catch (messageError) {
        console.error(`❌ [DEBUG] Failed to send message to content script:`, messageError);
        throw messageError;
      }
    } else {
      // For non-Tock platforms, use original single-date behavior
      const result = await sendAutoFillFormMessage(preferences, tabId);
      return result;
    }
  } catch (error) {
    console.error(`💥 [DEBUG] Exception in attemptFormFill:`, error);
    console.error(`   Error type: ${error instanceof Error ? error.constructor.name : typeof error}`);
    console.error(`   Error message: ${error instanceof Error ? error.message : String(error)}`);
    console.error(`   Stack trace:`, error instanceof Error ? error.stack : 'N/A');
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
    await clearActiveTimer();

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
