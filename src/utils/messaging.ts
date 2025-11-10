import { Message, TockPreferences, ActiveTimer } from '../types';

// Send a message to the background script to fill the form
// The background script will navigate to the search URL and then trigger the content script
export const sendFillFormMessage = (preferences: TockPreferences, tabId?: number): Promise<void> => {
  return new Promise((resolve, reject) => {
    // Get the tab ID if not provided
    const sendMessage = (actualTabId: number) => {
      const message: Message = {
        type: 'FILL_FORM',
        payload: {
          preferences,
          tabId: actualTabId,
        },
      };

      chrome.runtime.sendMessage(message, (response) => {
        if (chrome.runtime.lastError) {
          reject(chrome.runtime.lastError);
        } else if (response && !response.success) {
          reject(new Error(response.error || 'Failed to fill form'));
        } else {
          resolve();
        }
      });
    };

    if (tabId) {
      sendMessage(tabId);
    } else {
      chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
        if (tabs[0]?.id) {
          sendMessage(tabs[0].id);
        } else {
          reject(new Error('No active tab found'));
        }
      });
    }
  });
};

// Send a message to trigger automatic form filling (from background script)
export const sendAutoFillFormMessage = (preferences: TockPreferences, tabId: number): Promise<{ success: boolean }> => {
  return new Promise((resolve, reject) => {
    const message: Message = {
      type: 'AUTO_FILL_FORM',
      payload: preferences,
    };

    chrome.tabs.sendMessage(tabId, message, (response) => {
      if (chrome.runtime.lastError) {
        reject(chrome.runtime.lastError);
      } else {
        resolve(response || { success: false });
      }
    });
  });
};

// Send a message to cancel the active timer
export const sendCancelTimerMessage = (): Promise<void> => {
  return new Promise((resolve, reject) => {
    const message: Message = {
      type: 'CANCEL_TIMER',
    };

    chrome.runtime.sendMessage(message, (response) => {
      if (chrome.runtime.lastError) {
        reject(chrome.runtime.lastError);
      } else {
        resolve();
      }
    });
  });
};

// Send a message to get the current timer status
export const sendGetTimerStatusMessage = (): Promise<ActiveTimer | null> => {
  return new Promise((resolve, reject) => {
    const message: Message = {
      type: 'GET_TIMER_STATUS',
    };

    chrome.runtime.sendMessage(message, (response) => {
      if (chrome.runtime.lastError) {
        reject(chrome.runtime.lastError);
      } else {
        resolve(response);
      }
    });
  });
}; 