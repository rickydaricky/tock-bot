import { Message, TockPreferences } from '../types';
import { TockFormFiller } from './form-filler';

console.log('Tock Form Filler Content Script Loaded');

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

// Handle form filling
const handleFormFill = async (preferences: TockPreferences): Promise<boolean> => {
  try {
    const formFiller = new TockFormFiller({
      preferences,
      waitForForm: true,
      autoSubmit: true,
    });

    return await formFiller.fill();
  } catch (error) {
    console.error('Error filling form:', error);
    return false;
  }
}; 