import { Message, TockPreferences, Platform } from '../types';
import { TockFormFiller } from './form-filler';
import { OpenTableFormFiller } from './opentable-form-filler';
import { detectPlatform, getPlatformDisplayName } from '../utils/platform';

// Detect which platform we're on
const currentPlatform = detectPlatform(window.location.href);
console.log(`Form Filler Content Script Loaded - Platform: ${currentPlatform ? getPlatformDisplayName(currentPlatform) : 'Unknown'}`);

// Listen for messages from the background script
chrome.runtime.onMessage.addListener((message: Message, sender, sendResponse) => {
  console.log(`📩 [DEBUG] Content script received message:`, message);
  console.log(`   Message type: ${message.type}`);
  console.log(`   Current URL: ${window.location.href}`);

  // Handle form fill triggered by background script (both manual and automatic modes)
  // The background script navigates to the search URL before sending this message
  if (message.type === 'AUTO_FILL_FORM') {
    const payload = message.payload as any;
    const preferences = payload.preferences || payload as TockPreferences;
    const datesToTry = payload.datesToTry as string[] | undefined;

    const messageReceivedTime = Date.now();

    if (preferences.alarmFireTime) {
      console.log(`⏰ [TIMING] Content script received message (delta from alarm: ${(messageReceivedTime - preferences.alarmFireTime).toFixed(2)}ms)`);
    }

    // If datesToTry is provided, use multi-date mode
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
      } else {
        console.error('Multi-date mode only supported for Tock');
        sendResponse({ success: false, error: 'Multi-date mode only supported for Tock' });
      }
    } else {
      // Single date mode (original behavior)
      handleFormFill(preferences)
        .then((success) => {
          sendResponse({ success });
        })
        .catch((error) => {
          console.error('Error auto-filling form:', error);
          sendResponse({ success: false, error: error.message });
        });
    }

    return true; // Indicates an async response
  }
});

// Handle form filling with platform-specific form filler
const handleFormFill = async (preferences: TockPreferences): Promise<boolean> => {
  try {
    if (!currentPlatform) {
      console.error('Unable to determine platform from URL');
      return false;
    }

    let formFiller: TockFormFiller | OpenTableFormFiller;

    switch (currentPlatform) {
      case 'tock':
        console.log('Using Tock form filler');
        formFiller = new TockFormFiller({
          preferences,
          waitForForm: true,
          autoSubmit: true, // Auto-click search and book buttons
        });
        break;

      case 'opentable':
        console.log('Using OpenTable form filler');
        formFiller = new OpenTableFormFiller({
          preferences,
          waitForForm: true,
          autoSubmit: true, // Auto-click first available time slot
        });
        break;

      default:
        console.error(`Unknown platform: ${currentPlatform}`);
        return false;
    }

    return await formFiller.fill();
  } catch (error) {
    console.error('Error filling form:', error);
    return false;
  }
}; 