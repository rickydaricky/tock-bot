/**
 * Typed messaging helpers between the popup/content scripts and the background
 * service worker.
 *
 * Chrome's messaging APIs are callback-based and untyped; these wrappers give
 * each cross-context request a single, promise-returning entry point with a
 * strongly-typed {@link Message} envelope, so callers can `await`/`catch`
 * instead of threading callbacks and manually checking `chrome.runtime.lastError`.
 *
 * Two transports are used deliberately and are NOT interchangeable:
 *   - `chrome.runtime.sendMessage` — reaches the background service worker
 *     (the extension's central router). Used for control-plane requests:
 *     FILL_FORM, CANCEL_TIMER, GET_TIMER_STATUS.
 *   - `chrome.tabs.sendMessage(tabId, …)` — reaches the content script running
 *     inside a specific page/tab. Used for AUTO_FILL_FORM, which must execute
 *     DOM automation in the target Tock tab.
 *
 * Every helper rejects on `chrome.runtime.lastError` (e.g. no receiver
 * listening / port closed) so those failures surface as normal promise
 * rejections rather than being silently swallowed.
 *
 * Key exports: sendFillFormMessage, sendAutoFillFormMessage,
 * sendCancelTimerMessage, sendGetTimerStatusMessage.
 */
import { Message, TockPreferences, ActiveTimer } from '../types';

/**
 * Ask the background service worker to fill the booking form.
 *
 * The background script owns the two-step flow the popup can't perform itself:
 * it navigates the target tab to the built search URL and then triggers the
 * content script to fill/submit. Resolves only once the background reports
 * success; a `{ success: false }` response is turned into a rejection carrying
 * the server-supplied `error` string.
 *
 * @param tabId - Target tab. When omitted, the active tab in the current window
 *   is resolved via `chrome.tabs.query`; rejects if no active tab exists.
 */
export const sendFillFormMessage = (preferences: TockPreferences, tabId?: number): Promise<void> => {
  return new Promise((resolve, reject) => {
    // Inner sender bound to a concrete tab id — factored out so both the
    // explicit-tabId and resolved-active-tab paths share identical dispatch
    // and response-handling logic.
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
          // Delivery failure (no listener / worker asleep / port closed).
          reject(chrome.runtime.lastError);
        } else if (response && !response.success) {
          // Message was delivered but the background handler reported a
          // logical failure; propagate its error text when present.
          reject(new Error(response.error || 'Failed to fill form'));
        } else {
          resolve();
        }
      });
    };

    // A truthy tabId is used as-is; otherwise fall back to the active tab in
    // the current window (the common popup case, where no id is passed).
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

/**
 * Tell the content script in `tabId` to auto-fill (and submit) the form.
 *
 * Unlike {@link sendFillFormMessage}, this targets a content script directly
 * via `chrome.tabs.sendMessage`, so it is invoked from the background script
 * once the tab is on the right page. The payload is the bare preferences object
 * (no envelope wrapper around a `tabId`), matching the content script's
 * AUTO_FILL_FORM handler.
 *
 * Resolves with the content script's `{ success }` acknowledgement, defaulting
 * to `{ success: false }` if the receiver returns nothing (e.g. no response
 * sent). Still rejects on transport-level `lastError`.
 */
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

/**
 * Ask the background script to cancel the currently scheduled drop timer.
 *
 * The background service worker owns the countdown/alarm state, so cancellation
 * is a control-plane request over `chrome.runtime.sendMessage`. Resolves once
 * acknowledged; the response body is intentionally ignored (fire-and-confirm).
 */
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

/**
 * Fetch the background script's current drop-timer state for the popup UI.
 *
 * Resolves with the {@link ActiveTimer} record, or `null` when no timer is
 * scheduled — the response is forwarded verbatim, so the background handler is
 * responsible for returning `null` in the idle case.
 */
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