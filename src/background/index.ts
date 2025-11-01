// This is the background script for the Tock Reservation Form Filler extension
import { Message, TockPreferences, ActiveTimer } from '../types';
import { DEFAULT_PREFERENCES, saveActiveTimer, loadActiveTimer, clearActiveTimer, loadPreferences } from '../utils/storage';
import { sendAutoFillFormMessage } from '../utils/messaging';

console.log('Tock Form Filler Background Script Loaded');

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

    // Attempt to fill the form on the target tab
    if (activeTimer.tabId) {
      const result = await attemptFormFill(activeTimer.tabId, preferences);

      if (result.success) {
        // Success! Mark as completed
        activeTimer.status = 'completed';
        await saveActiveTimer(activeTimer);
        console.log('Form filled successfully');
      } else {
        // Failed, try retry logic
        await handleRetry(activeTimer, preferences);
      }
    } else {
      // No tab ID, mark as failed
      activeTimer.status = 'failed';
      await saveActiveTimer(activeTimer);
      console.error('No tab ID specified for timer');
    }
  } catch (error) {
    console.error('Error executing auto-fill:', error);
    await handleRetry(activeTimer, await loadPreferences());
  }
}

// Attempt to fill the form on a specific tab
async function attemptFormFill(tabId: number, preferences: TockPreferences): Promise<{ success: boolean }> {
  try {
    const result = await sendAutoFillFormMessage(preferences, tabId);
    return result;
  } catch (error) {
    console.error('Error sending auto-fill message:', error);
    return { success: false };
  }
}

// Handle retry logic
async function handleRetry(timer: ActiveTimer, preferences: TockPreferences) {
  timer.currentAttempt++;

  if (timer.currentAttempt >= timer.maxRetries) {
    // Max retries reached, mark as failed
    timer.status = 'failed';
    await saveActiveTimer(timer);
    console.log('Max retries reached, marking as failed');
    return;
  }

  // Schedule next retry
  await saveActiveTimer(timer);
  console.log(`Retry attempt ${timer.currentAttempt} of ${timer.maxRetries}`);

  // Get retry interval from preferences
  const retryIntervalSeconds = preferences.retryIntervalSeconds || 1;

  // Wait and retry
  setTimeout(async () => {
    if (!timer.tabId) return;

    const result = await attemptFormFill(timer.tabId, preferences);

    if (result.success) {
      timer.status = 'completed';
      await saveActiveTimer(timer);
      console.log('Form filled successfully on retry');
    } else {
      await handleRetry(timer, preferences);
    }
  }, retryIntervalSeconds * 1000);
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
    maxRetries: preferences.maxRetries || 10,
    status: 'scheduled',
    tabId,
  };

  await saveActiveTimer(timer);
  console.log('Timer scheduled:', timer);

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
});

// The background script handles events and actions that need to persist
// beyond the lifecycle of the popup
