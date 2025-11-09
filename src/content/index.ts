import { Message, TockPreferences, Platform } from '../types';
import { TockFormFiller } from './form-filler';
import { OpenTableFormFiller } from './opentable-form-filler';
import { detectPlatform, getPlatformDisplayName } from '../utils/platform';

// Detect which platform we're on
const currentPlatform = detectPlatform(window.location.href);
console.log(`Form Filler Content Script Loaded - Platform: ${currentPlatform ? getPlatformDisplayName(currentPlatform) : 'Unknown'}`);

// Listen for messages from the popup and background script
chrome.runtime.onMessage.addListener((message: Message, sender, sendResponse) => {
  console.log('Message received in content script:', message);

  if (message.type === 'FILL_FORM') {
    const preferences = message.payload as TockPreferences;
    handleFormFill(preferences)
      .then((success) => {
        sendResponse({ success });
      })
      .catch((error) => {
        console.error('Error filling form:', error);
        sendResponse({ success: false, error: error.message });
      });

    return true; // Indicates an async response
  }

  // Handle automatic form fill triggered by background script timer
  if (message.type === 'AUTO_FILL_FORM') {
    const preferences = message.payload as TockPreferences;
    const messageReceivedTime = Date.now();
    
    if (preferences.alarmFireTime) {
      console.log(`⏰ [TIMING] Content script received message (delta from alarm: ${(messageReceivedTime - preferences.alarmFireTime).toFixed(2)}ms)`);
    }
    
    handleFormFill(preferences)
      .then((success) => {
        sendResponse({ success });
      })
      .catch((error) => {
        console.error('Error auto-filling form:', error);
        sendResponse({ success: false, error: error.message });
      });

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