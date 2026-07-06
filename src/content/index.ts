/**
 * Content-script entry point (injected into every Tock/OpenTable/Resy checkout page).
 *
 * Single responsibility: on load, decide *where* this script is running and route
 * accordingly, then wire up the `chrome.runtime.onMessage` bridge to the background
 * service worker so it can drive form-filling remotely.
 *
 * Two mutually-exclusive execution contexts are selected by hostname:
 *  1. Resy's cross-origin booking widget iframe (`widgets.resy.com`) — the "Reserve
 *     Now" button lives *inside* this iframe, unreachable from the parent page, so a
 *     copy of this script runs here purely to receive a `CLICK_RESERVE_BUTTON` message
 *     and click that button from within the iframe's own origin. It deliberately skips
 *     all main-page logic to avoid double-running the platform routing.
 *  2. The top-level checkout page (everything else) — detects the platform from the URL
 *     and dispatches `AUTO_FILL_FORM` messages to the matching platform form-filler
 *     ({@link TockFormFiller} / {@link OpenTableFormFiller} / {@link ResyFormFiller}).
 *
 * This file exports nothing; it is a side-effecting entry module. Its "API" is the set
 * of message types it listens for: `CLICK_RESERVE_BUTTON` (iframe) and `AUTO_FILL_FORM`
 * (main page). All message handlers return `true` to keep the port open for the async
 * `sendResponse`, which is how success/failure is reported back to the background worker.
 */
import { Message, TockPreferences, Platform } from '../types';
import { TockFormFiller } from './form-filler';
import { OpenTableFormFiller } from './opentable-form-filler';
import { ResyFormFiller } from './resy-form-filler';
import { detectPlatform, getPlatformDisplayName } from '../utils/platform';

// Special handling for Resy widget iframe.
// Resy renders its checkout inside a cross-origin `widgets.resy.com` iframe, so the
// parent-page content script can't reach the Reserve button across the origin boundary.
// This branch runs the *same* content script when injected into that iframe and does
// nothing but act as a click proxy for the parent (see CLICK_RESERVE_BUTTON below).
if (window.location.hostname === 'widgets.resy.com') {
  console.log('Content script loaded in Resy widget iframe');

  // Bridge from the parent page: the parent's form-filler can't click across the
  // iframe origin boundary, so it posts CLICK_RESERVE_BUTTON and this in-iframe copy
  // performs the actual DOM click on Resy's behalf.
  chrome.runtime.onMessage.addListener((message: Message, sender, sendResponse) => {
    console.log('📩 [IFRAME] Received message:', message);

    if (message.type === 'CLICK_RESERVE_BUTTON') {
      console.log('[IFRAME] Searching for Reserve Now button...');

      // Resy-specific selector: the final "Reserve Now" CTA is tagged with this stable
      // data-test-id inside the order summary widget.
      const button = document.querySelector('[data-test-id="order_summary_page-button-book"]') as HTMLElement;

      if (button) {
        console.log('[IFRAME] Found Reserve Now button, checking if clickable...');

        // Guard against clicking a button that's hidden or still disabled (Resy disables
        // it until the slot/party details validate). `offsetParent === null` is the cheap
        // "is it rendered/visible" check; a `disabled` attribute means not yet actionable.
        const isVisible = button.offsetParent !== null;
        const isEnabled = !button.hasAttribute('disabled');

        console.log('[IFRAME] Button state:', { isVisible, isEnabled });

        if (isVisible && isEnabled) {
          console.log('[IFRAME] Clicking Reserve Now button!');
          button.click();
          sendResponse({ success: true });
        } else {
          console.log('[IFRAME] Button found but not clickable');
          sendResponse({ success: false, error: 'Button not clickable' });
        }
      } else {
        console.log('[IFRAME] Reserve Now button not found');
        sendResponse({ success: false, error: 'Button not found' });
      }

      return true; // Keep message channel open for async response
    }
  });

  // The iframe context stops here — falling through into the main-page routing below
  // would double-register listeners and try to platform-detect the widget's own URL.
  console.log('[IFRAME] Skipping main page logic');
} else {
  // Main page logic - only run if NOT in iframe

  // Resolve the platform once, from the top-level URL, and reuse it for every message.
  // `null` means the URL didn't match any known booking platform (unexpected host).
  const currentPlatform = detectPlatform(window.location.href);
  console.log(`Form Filler Content Script Loaded - Platform: ${currentPlatform ? getPlatformDisplayName(currentPlatform) : 'Unknown'}`);

  // Primary message bridge from the background service worker. The worker navigates the
  // tab to the search/checkout URL first, then sends AUTO_FILL_FORM to kick off filling.
  chrome.runtime.onMessage.addListener((message: Message, sender, sendResponse) => {
  console.log(`📩 [DEBUG] Content script received message:`, message);
  console.log(`   Message type: ${message.type}`);
  console.log(`   Current URL: ${window.location.href}`);

  // Handle form fill triggered by background script (both manual and automatic modes)
  // The background script navigates to the search URL before sending this message
  if (message.type === 'AUTO_FILL_FORM') {
    // Backwards-compatible payload shape: newer callers wrap prefs in `{ preferences, datesToTry }`,
    // while older callers sent the bare TockPreferences object as the payload itself.
    const payload = message.payload as any;
    const preferences = payload.preferences || payload as TockPreferences;
    const datesToTry = payload.datesToTry as string[] | undefined;

    const messageReceivedTime = Date.now();

    // Timing instrumentation for sniper mode: measures the alarm-fire → content-script
    // hop latency, which counts against the drop window and is worth watching.
    if (preferences.alarmFireTime) {
      console.log(`⏰ [TIMING] Content script received message (delta from alarm: ${(messageReceivedTime - preferences.alarmFireTime).toFixed(2)}ms)`);
    }

    // Multi-date mode: caller supplied a prioritized list of dates to attempt in order
    // (first bookable one wins). Only Tock and Resy implement this; OpenTable falls
    // through to the single-date path via the else branch.
    if (datesToTry && datesToTry.length > 0) {
      console.log(`📅 Multi-date mode: trying ${datesToTry.length} dates`);

      if (currentPlatform === 'tock') {
        const formFiller = new TockFormFiller({
          preferences,
          waitForForm: true,
          autoSubmit: true,
        });

        console.log(`🎯 [DEBUG] Calling tryMultipleDates with ${datesToTry.length} dates`);
        formFiller.tryMultipleDates(datesToTry)
          .then((success) => {
            console.log(`📊 [DEBUG] tryMultipleDates returned: ${success}`);
            sendResponse({ success });
          })
          .catch((error) => {
            console.error(`💥 [DEBUG] tryMultipleDates threw exception:`, error);
            console.error('Error trying multiple dates:', error);
            sendResponse({ success: false, error: error.message });
          });
      } else if (currentPlatform === 'resy') {
        const formFiller = new ResyFormFiller({
          preferences,
          waitForForm: true,
          autoSubmit: true,
        });

        console.log(`🎯 [DEBUG] Calling fillForm (Resy) with ${datesToTry.length} dates`);
        formFiller.fillForm(datesToTry)
          .then((success) => {
            console.log(`📊 [DEBUG] fillForm (Resy) returned: ${success}`);
            sendResponse({ success });
          })
          .catch((error) => {
            console.error(`💥 [DEBUG] fillForm (Resy) threw exception:`, error);
            console.error('Error filling Resy form:', error);
            sendResponse({ success: false, error: error.message });
          });
      } else if (currentPlatform === 'opentable') {
        console.log(`🎯 [DEBUG] OpenTable multi-date mode: trying ${datesToTry.length} dates`);
        (async () => {
          for (const date of datesToTry) {
            const datePrefs = { ...preferences, date };
            const filler = new OpenTableFormFiller({
              preferences: datePrefs,
              waitForForm: true,
              autoSubmit: true,
            });
            const success = await filler.fill();
            if (success) {
              sendResponse({ success: true });
              return;
            }
          }
          sendResponse({ success: false });
        })();
      } else {
        console.error('Multi-date mode only supported for Tock, Resy, and OpenTable');
        sendResponse({ success: false, error: 'Multi-date mode only supported for Tock, Resy, and OpenTable' });
      }
    } else {
      // Single-date mode (original behavior): fill for the one date encoded in the
      // preferences/URL, dispatching to the correct platform via handleFormFill.
      handleFormFill(preferences)
        .then((success) => {
          sendResponse({ success });
        })
        .catch((error) => {
          console.error('Error auto-filling form:', error);
          sendResponse({ success: false, error: error.message });
        });
    }

    // Returning true tells Chrome the sendResponse above is async — without it the
    // message port closes immediately and the background worker never gets the result.
    return true; // Indicates an async response
  }
});

/**
 * Single-date dispatch: instantiate the form-filler matching the current platform and
 * run it once for the date carried in `preferences`. All fillers are configured to wait
 * for the form to render and to auto-submit (click search + book/reserve) so the whole
 * flow completes hands-off.
 *
 * Returns `true` only if the platform's filler reports success; returns `false` (never
 * throws) for an unknown platform, an unrecognized URL, or any error thrown mid-fill —
 * so the caller's `.then(success => ...)` always resolves with a boolean outcome.
 */
const handleFormFill = async (preferences: TockPreferences): Promise<boolean> => {
  try {
    if (!currentPlatform) {
      console.error('Unable to determine platform from URL');
      return false;
    }

    let formFiller: TockFormFiller | OpenTableFormFiller | ResyFormFiller;

    switch (currentPlatform) {
      case 'tock':
        console.log('Using Tock form filler');
        formFiller = new TockFormFiller({
          preferences,
          waitForForm: true,
          autoSubmit: true, // Auto-click search and book buttons
        });
        return await formFiller.fill();

      case 'opentable':
        console.log('Using OpenTable form filler');
        formFiller = new OpenTableFormFiller({
          preferences,
          waitForForm: true,
          autoSubmit: true, // Auto-click first available time slot
        });
        return await formFiller.fill();

      case 'resy':
        console.log('Using Resy form filler');
        formFiller = new ResyFormFiller({
          preferences,
          waitForForm: true,
          autoSubmit: true, // Auto-click time slot and reserve button
        });
        return await formFiller.fillForm();

      default:
        console.error(`Unknown platform: ${currentPlatform}`);
        return false;
    }
  } catch (error) {
    console.error('Error filling form:', error);
    return false;
  }
};

} // End of main page logic (else block) — the counterpart to the widgets.resy.com iframe branch above.