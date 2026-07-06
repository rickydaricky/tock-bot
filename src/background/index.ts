/**
 * Extension service worker (MV3 background script) for the Tock Reservation Form Filler.
 *
 * Single responsibility: own all persistent, popup-independent state and coordination for
 * scheduled auto-booking. The popup is ephemeral (closes constantly), so the drop-timing
 * countdown, cross-frame message relaying, and tab orchestration must live here.
 *
 * What it does:
 *  - Scheduling: converts a user-configured "drop time" into a `chrome.alarms` timer that fires
 *    `leadTimeMs` early, then at fire time reloads the target tab and tells the content script to
 *    grab a slot. Persists the timer to storage so it survives the service worker being torn down.
 *  - Alarm recovery: MV3 service workers are killed aggressively and can lose in-memory state, so
 *    `onStartup` re-hydrates and recreates any still-future alarm from persisted `ActiveTimer`.
 *  - Message routing: relays cross-origin `CLICK_RESERVE_BUTTON` from the main page into all frames
 *    (iframes), and services SCHEDULE_TIMER / CANCEL_TIMER / GET_TIMER_STATUS / FILL_FORM requests
 *    from the popup.
 *  - Platform dispatch: Tock and Resy get a navigate-to-search-URL-then-refresh strategy; other
 *    platforms (OpenTable) fall back to the generic single-date form-fill message.
 *
 * Key entry points (all module-scoped — a service worker has no ES exports):
 *  - `scheduleTimer`, `cancelTimer`, `getTimerStatus` — timer lifecycle.
 *  - `handleAlarmTrigger` — the drop-time execution path.
 *  - `attemptFormFill` / `attemptManualFormFill` — scheduled (with refresh) vs. user-initiated fills.
 *  - `buildDesiredDatesList` — expands preferences into the ordered date list content scripts try.
 *  - The `chrome.runtime.onMessage` listener — popup/content-script command router.
 */
// This is the background script for the Tock Reservation Form Filler extension
import { Message, TockPreferences, ActiveTimer } from '../types';
import { DEFAULT_PREFERENCES, saveActiveTimer, loadActiveTimer, clearActiveTimer, loadPreferences } from '../utils/storage';
import { sendAutoFillFormMessage } from '../utils/messaging';
import { detectPlatform } from '../utils/platform';
import { buildTockSearchUrl, buildTockSearchUrlWithDate, buildResySearchUrl, buildResySearchUrlWithDate } from '../utils/url-builder';

console.log('Tock Form Filler Background Script Loaded');

/**
 * Build the ordered list of dates the content script should try, in YYYY-MM-DD format.
 *
 * Ordering is load-bearing: `preferences.date` (the primary date) is always index 0, and callers
 * (`attemptFormFill` / `attemptManualFormFill`) navigate to the search URL for `desiredDates[0]`.
 *
 * Precedence of the extra dates:
 *  1. Calendar-selected `selectedDates` win outright — if the user hand-picked dates, the auto-scan
 *     range is ignored entirely (they're mutually exclusive, not additive).
 *  2. Otherwise, if `useFirstAvailableAfter` is on, scan ±`maxDaysToScan` (default 7) days around the
 *     primary date. The offset==0 case is skipped because the primary date is already index 0.
 * Duplicates are de-duped so the primary date is never retried redundantly.
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

/**
 * Prefix for every scheduled-search alarm name. The `onAlarm` listener filters on this prefix so
 * that unrelated alarms (from Chrome or other extension features) are ignored; concrete alarm names
 * append a `Date.now()` timestamp for uniqueness (see `scheduleTimer`).
 */
const ALARM_NAME_PREFIX = 'tock-auto-search';

// On first install, seed storage with DEFAULT_PREFERENCES so the popup has a valid baseline config.
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

/**
 * Alarm recovery on browser/service-worker startup.
 *
 * `chrome.alarms` normally persist, but a browser restart (or a lost worker) can leave a still-
 * 'scheduled' `ActiveTimer` in storage whose backing alarm no longer exists. Here we reconcile:
 * if the persisted timer has no live alarm, recreate it when the fire time is still in the future,
 * otherwise treat it as expired and clear it so the popup doesn't show a stale countdown.
 */
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

// Alarm fired: only our scheduled-search alarms (matching ALARM_NAME_PREFIX) trigger a booking run.
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

/**
 * Drop-time execution path: run once when a scheduled alarm fires.
 *
 * Guards against a stale/mismatched alarm (the persisted timer must name this exact alarm), then
 * drives the timer through running → completed/failed while persisting each transition so the popup
 * reflects live state even though this worker may be killed between events. `alarmFireTime` is
 * threaded into `preferences` and logged at each stage purely to measure end-to-end latency from
 * alarm fire to slot grab (every ms matters at a competitive drop). The whole body is wrapped so an
 * exception can never leave the timer stuck in 'running'.
 */
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

/**
 * Resolve once the given tab reaches `status === 'complete'` after a reload/navigation.
 *
 * Uses a `chrome.tabs.onUpdated` listener rather than awaiting `chrome.tabs.reload`, because reload
 * resolves when the command is accepted, not when the page has actually finished loading. Notes:
 *  - `completed` flag + explicit listener removal prevent double-resolve and listener leaks.
 *  - Hard 5s timeout rejects so a hung navigation can't stall the whole booking run.
 *  - A 150ms buffer after 'complete' gives the page's scripts a moment to initialize before the
 *    content script is messaged (empirically avoids racing Tock's client-side hydration).
 */
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

/**
 * User-initiated "fill now" path (the popup's manual button).
 *
 * Mirrors `attemptFormFill` but deliberately omits the reload/retry loop: the user is present and
 * acting now, so we navigate straight to the freshly-built search URL for the primary date and hand
 * the full `desiredDates` list to the content script to try. Tock and Resy each build a
 * platform-specific dated search URL; anything else falls back to the generic single-date
 * `sendAutoFillFormMessage`. Errors are swallowed into `{ success: false }` so a bad tab/URL can't
 * throw into the message handler.
 */
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
    } else if (platform === 'resy') {
      console.log(`🔄 Manual fill - Resy platform detected, navigating to venue page with params`);
      const navigateStartTime = Date.now();

      // Build search URL with the PRIMARY date (first in list)
      const primaryDate = desiredDates[0];
      const searchUrl = buildResySearchUrlWithDate(tab.url, preferences, primaryDate);

      if (!searchUrl) {
        console.error('Failed to build Resy search URL');
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
      // For non-Tock/Resy platforms, use original single-date behavior
      const result = await sendAutoFillFormMessage(preferences, tabId);
      return result;
    }
  } catch (error) {
    console.error('Error sending manual fill message:', error);
    return { success: false };
  }
}

/**
 * Scheduled (alarm-driven) fill path — the critical drop-time attempt.
 *
 * Key difference from the manual path: it *reloads* the tab first. `scheduleTimer` already parked
 * the tab on the search URL, so at the drop we don't navigate; we reload to force fresh availability
 * from the server (a stale cached page would show sold-out slots). When `autoRefreshOnNoSlots` is
 * set, it loops up to `maxRefreshRetries` (default 3) with *no* delay — immediate re-reloads to race
 * slots that appear a beat late. Returns as soon as the content script reports success. Tock and
 * Resy share this reload-then-message strategy; other platforms fall back to the generic single-date
 * message. Reload/wait/message failures re-throw inside the loop and are caught at the outer try so
 * the caller records a clean failure rather than a hang.
 */
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

      // Determine retry settings
      const maxAttempts = preferences.autoRefreshOnNoSlots ? (preferences.maxRefreshRetries ?? 3) : 1;

      // Retry loop for auto-refresh feature (immediate retries, no delay)
      for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        console.log(`📍 Attempt ${attempt}/${maxAttempts}`);
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

          // If successful, return immediately
          if (result.success) {
            console.log(`✅ Success on attempt ${attempt}/${maxAttempts}`);
            return { success: true };
          }

          // If failed but we have more attempts, retry immediately
          console.log(`❌ No slots found on attempt ${attempt}/${maxAttempts}${attempt < maxAttempts ? ', retrying immediately...' : ''}`);

        } catch (messageError) {
          console.error(`❌ [DEBUG] Failed to send message to content script:`, messageError);
          throw messageError;
        }
      }

      // All attempts failed
      console.log(`❌ Failed after ${maxAttempts} attempts`);
      return { success: false };
    } else if (platform === 'resy') {
      console.log(`🔄 Resy platform detected - page already on venue URL, refreshing for fresh data`);

      // Determine retry settings
      const maxAttempts = preferences.autoRefreshOnNoSlots ? (preferences.maxRefreshRetries ?? 3) : 1;

      // Retry loop for auto-refresh feature (immediate retries, no delay)
      for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        console.log(`📍 Attempt ${attempt}/${maxAttempts}`);
        const reloadStartTime = Date.now();

        // Refresh the page to get fresh data from server
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

          // If successful, return immediately
          if (result.success) {
            console.log(`✅ Success on attempt ${attempt}/${maxAttempts}`);
            return { success: true };
          }

          // If failed but we have more attempts, retry immediately
          console.log(`❌ No slots found on attempt ${attempt}/${maxAttempts}${attempt < maxAttempts ? ', retrying immediately...' : ''}`);

        } catch (messageError) {
          console.error(`❌ [DEBUG] Failed to send message to content script:`, messageError);
          throw messageError;
        }
      }

      // All attempts failed
      console.log(`❌ Failed after ${maxAttempts} attempts`);
      return { success: false };
    } else {
      // For non-Tock/Resy platforms, use original single-date behavior
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

/**
 * Create (and persist) the timer that fires at drop time.
 *
 * Fires `leadTimeMs` (default 200ms) *before* `dropTime` to absorb alarm/scheduling jitter and the
 * reload latency, so the slot-grab lands right at the drop rather than after it. Throws if drop time
 * is missing or the computed fire time is already in the past. Any prior timer is cancelled first so
 * there is only ever one active alarm.
 *
 * Side effect that's easy to miss: for Tock/Resy it immediately navigates the tab to the search URL
 * so the page is "warm" and only needs a cheap reload at fire time (see `attemptFormFill`). If the
 * search URL can't be built we leave the tab as-is and rely on the content script's form-filling
 * fallback. OpenTable intentionally gets no pre-navigation.
 */
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
      } else if (platform === 'resy') {
        const searchUrl = buildResySearchUrl(tab.url, preferences);

        if (searchUrl) {
          console.log('🔗 Navigating to Resy venue URL:', searchUrl);
          await chrome.tabs.update(tabId, { url: searchUrl });
        } else {
          console.warn('Failed to build Resy search URL, will use form filling approach');
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

/**
 * Cancel the active timer: clear the backing `chrome.alarms` entry and remove the persisted timer.
 * Marks the timer 'cancelled' before clearing so any listener observing storage sees the terminal
 * state. No-op if there is no active timer.
 */
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

/** Return the persisted active timer (or null) so the popup can render its countdown/status. */
async function getTimerStatus(): Promise<ActiveTimer | null> {
  return await loadActiveTimer();
}

/**
 * Central command router for popup and content-script messages.
 *
 * Every branch that does async work returns `true` to keep the message channel open until
 * `sendResponse` fires — omitting it would drop the reply and hang the caller.
 *
 * Handled messages:
 *  - CLICK_RESERVE_BUTTON: re-broadcasts to *all* frames of the sender's tab so the reserve click
 *    reaches the cross-origin reservation iframe (the main-page content script can't reach into it).
 *  - CANCEL_TIMER / GET_TIMER_STATUS / SCHEDULE_TIMER: timer lifecycle proxied to the helpers above.
 *  - FILL_FORM: manual "fill now" — expands the date list and runs the no-refresh fill path.
 */
chrome.runtime.onMessage.addListener((message: Message, sender, sendResponse) => {
  console.log('Background received message:', message);

  // Relay CLICK_RESERVE_BUTTON from main page to iframe
  if (message.type === 'CLICK_RESERVE_BUTTON') {
    console.log('[Background] Relaying CLICK_RESERVE_BUTTON to all frames');

    // Get the tab that sent the message
    if (!sender.tab?.id) {
      console.error('[Background] No tab ID in sender');
      sendResponse({ success: false, error: 'No tab ID' });
      return false;
    }

    // Send message to all frames in the tab (including iframes)
    chrome.tabs.sendMessage(
      sender.tab.id,
      { type: 'CLICK_RESERVE_BUTTON' },
      (response) => {
        if (chrome.runtime.lastError) {
          console.error('[Background] Error relaying message:', chrome.runtime.lastError.message);
          sendResponse({ success: false, error: chrome.runtime.lastError.message });
        } else {
          console.log('[Background] Received response from iframe:', response);
          sendResponse(response);
        }
      }
    );

    return true; // Keep channel open for async response
  }

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
