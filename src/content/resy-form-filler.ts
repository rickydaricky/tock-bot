/**
 * resy-form-filler.ts — Resy (resy.com) checkout automation content script.
 *
 * Responsibility: given a set of booking preferences, drive Resy's Angular
 * venue page to grab an available time slot and advance into the reservation
 * flow — pick the slot closest to the preferred time, then click "Reserve Now".
 * If the current date has no availability, optionally walk a list of fallback
 * dates via the calendar until one has open slots.
 *
 * Role in the system: the Resy sibling of `form-filler.ts` (Tock) and
 * `opentable-form-filler.ts` (OpenTable). It is instantiated by the content
 * script entrypoint for resy.com pages; the floating-timer / background worker
 * decides *when* to fire, this class decides *what* to click.
 *
 * Resy-specific gotchas encoded here (reverse-engineered, empirical):
 *  - The venue page renders via Angular, so slots/calendar appear asynchronously
 *    after load. Every "find X" routine waits on a MutationObserver rather than
 *    assuming the DOM is ready.
 *  - The time-slot list ALWAYS contains a "Notify" button even when there is no
 *    real availability; it must be excluded (`ReservationButtonList__notify-button`)
 *    or we'd mistake "notify me" for a bookable slot.
 *  - The final "Reserve Now" button lives inside the cross-origin
 *    widgets.resy.com iframe, so this (top-frame) script cannot click it
 *    directly — it delegates via a CLICK_RESERVE_BUTTON runtime message handled
 *    by the content script injected into that iframe.
 *  - All DOM hooks are Resy's `data-test-id` / class attributes, which are the
 *    stable-ish handles Resy ships; selectors are the load-bearing part of this
 *    file and break when Resy reskins.
 *
 * Key export: `ResyFormFiller` (class) — `fillForm()` is the main entrypoint,
 * `tryMultipleDates()` the public fallback-date search.
 */
import { FormFillerOptions, TockPreferences } from '../types';

/**
 * Drives the Resy venue page to select a time slot and open the reservation
 * modal. Stateless between runs aside from the injected `preferences` and the
 * `waitForForm` / `autoSubmit` behaviour flags captured at construction.
 */
export class ResyFormFiller {
  private preferences: TockPreferences;
  private waitForForm: boolean;
  /** When false, stop after confirming availability instead of clicking through the slot + Reserve button. */
  private autoSubmit: boolean;

  /** Both behaviour flags default to true (wait for the form, then auto-submit) when the caller omits them. */
  constructor(options: FormFillerOptions) {
    this.preferences = options.preferences;
    this.waitForForm = options.waitForForm ?? true;
    this.autoSubmit = options.autoSubmit ?? true;
  }

  /**
   * Main entry point for filling the Resy reservation form.
   *
   * Flow: wait for the slot container → verify it holds real slot buttons (not
   * just the Notify button) → if empty, fall back to `tryMultipleDates` when
   * `desiredDates` were supplied → otherwise click the closest slot and then the
   * Reserve button.
   *
   * Return semantics are deliberately loose: `true` means "we got at least as
   * far as confirming availability" — note it returns `true` even when
   * `autoSubmit` is off or the Reserve click never lands, because reaching the
   * slot list is treated as success for the caller's retry logic. Only hard
   * failures (no slots + no fallback dates, or a thrown error) return `false`.
   */
  public async fillForm(desiredDates?: string[]): Promise<boolean> {
    try {
      console.log('Starting Resy form fill with preferences:', this.preferences);

      // Wait for the time slot container to load (Resy loads via Angular)
      const hasTimeSlots = await this.waitForTimeSlots();

      if (!hasTimeSlots) {
        console.log('No time slots container found, checking if we need to try fallback dates...');

        // If we have desired dates, try them
        if (desiredDates && desiredDates.length > 0) {
          console.log('Attempting to find availability on fallback dates...');
          return await this.tryMultipleDates(desiredDates);
        }

        console.error('No time slots available and no fallback dates provided');
        return false;
      }

      // The container renders even when a date is fully booked — in that case it
      // holds only the "Notify" button. Excluding that button is what
      // distinguishes real availability from "notify me", so a non-empty result
      // here is the actual "slots exist" signal.
      const container = document.querySelector('[data-test-id="reservation-button-test-list"]');
      const timeButtons = container?.querySelectorAll('button:not([data-testid="ReservationButtonList__notify-button"])');

      if (!timeButtons || timeButtons.length === 0) {
        console.log('No time slot buttons available for current date');

        // Try fallback dates if available
        if (desiredDates && desiredDates.length > 0) {
          console.log('Attempting to find availability on fallback dates...');
          return await this.tryMultipleDates(desiredDates);
        }

        console.error('No time slot buttons and no fallback dates to try');
        return false;
      }

      console.log(`Found ${timeButtons.length} time slot buttons available!`);

      // Time slots are available, try to click one
      if (this.autoSubmit) {
        console.log('Time slots available, attempting to click matching time...');
        const clicked = await this.clickTimeSlot();
        if (clicked) {
          console.log('Successfully clicked time slot!');

          // Wait for modal to appear after clicking time slot
          console.log('Waiting for reservation modal to load...');
          await this.wait(1500);

          // Wait for and click the Reserve Now button
          const reserved = await this.clickReserveButton();
          if (reserved) {
            console.log('Successfully clicked Reserve Now button!');
            return true;
          }
        }
      }

      return true;
    } catch (error) {
      console.error('Error filling Resy form:', error);
      return false;
    }
  }

  /**
   * Resolve `true` once the time-slot list container exists in the DOM, or
   * `false` after `timeout` ms. Because Resy hydrates the page via Angular, the
   * container may not exist at call time; we check once synchronously and
   * otherwise watch for it with a MutationObserver. Note this only proves the
   * *container* mounted — callers still have to inspect it for real slot buttons
   * (see the Notify-button exclusion in `fillForm`).
   */
  private async waitForTimeSlots(timeout = 10000): Promise<boolean> {
    return new Promise((resolve) => {
      const startTime = Date.now();

      const checkSlots = () => {
        const container = document.querySelector('[data-test-id="reservation-button-test-list"]');
        return container !== null;
      };

      if (checkSlots()) {
        resolve(true);
        return;
      }

      const observer = new MutationObserver(() => {
        if (checkSlots()) {
          observer.disconnect();
          resolve(true);
        } else if (Date.now() - startTime > timeout) {
          observer.disconnect();
          resolve(false);
        }
      });

      observer.observe(document.body, { childList: true, subtree: true });

      setTimeout(() => {
        observer.disconnect();
        resolve(false);
      }, timeout);
    });
  }

  /**
   * Click the slot whose time is nearest the preferred time.
   *
   * "Nearest" = minimum absolute difference in minutes-since-midnight between
   * `preferences.time` and each button's parsed time; an exact match short-
   * circuits the scan. There is no earlier/later bias — a slot 15 min before is
   * chosen over one 20 min after. Buttons whose text has no HH:MM AM/PM token
   * are skipped (this also naturally ignores the "Notify" button).
   *
   * Like `waitForTimeSlots`, retries via MutationObserver until a slot is found
   * or `timeout` elapses, to cope with slots streaming in asynchronously.
   */
  private async clickTimeSlot(timeout = 10000): Promise<boolean> {
    console.log(`Looking for time slots matching preferred time: ${this.preferences.time}`);

    return new Promise((resolve) => {
      const startTime = Date.now();

      const findAndClickSlot = () => {
        const container = document.querySelector('[data-test-id="reservation-button-test-list"]');
        if (!container) {
          return false;
        }

        // Get all time slot buttons (exclude the Notify button)
        const timeButtons = Array.from(container.querySelectorAll('button:not([data-testid="ReservationButtonList__notify-button"])'));

        if (timeButtons.length === 0) {
          return false;
        }

        console.log(`Found ${timeButtons.length} time slot buttons`);

        // Parse preferred time (format: HH:MM -> minutes since midnight)
        const preferredMinutes = this.parseTimeToMinutes(this.preferences.time);

        // Find the closest matching time
        let bestMatch: { button: Element; diff: number } | null = null;

        for (const button of timeButtons) {
          const buttonText = button.textContent?.trim() || '';
          const timeMatch = buttonText.match(/(\d{1,2}):(\d{2})\s*(AM|PM)/i);

          if (timeMatch) {
            const buttonMinutes = this.parse12HourTimeToMinutes(timeMatch[0]);
            const diff = Math.abs(buttonMinutes - preferredMinutes);

            if (!bestMatch || diff < bestMatch.diff) {
              bestMatch = { button, diff };
            }

            // If we find an exact match, use it immediately
            if (diff === 0) {
              break;
            }
          }
        }

        if (bestMatch) {
          console.log(`Found time slot: ${bestMatch.button.textContent?.trim()}, difference: ${bestMatch.diff} minutes`);

          // Scroll into view if needed
          bestMatch.button.scrollIntoView({ behavior: 'smooth', block: 'center' });

          // Click the button
          (bestMatch.button as HTMLElement).click();
          return true;
        }

        return false;
      };

      // Try immediately
      if (findAndClickSlot()) {
        resolve(true);
        return;
      }

      // Use MutationObserver for dynamic content
      const observer = new MutationObserver(() => {
        if (findAndClickSlot()) {
          observer.disconnect();
          resolve(true);
        } else if (Date.now() - startTime > timeout) {
          observer.disconnect();
          resolve(false);
        }
      });

      observer.observe(document.body, { childList: true, subtree: true });

      setTimeout(() => {
        observer.disconnect();
        if (findAndClickSlot()) {
          resolve(true);
        } else {
          resolve(false);
        }
      }, timeout);
    });
  }

  /**
   * Fallback path when the current date has no availability: walk the calendar
   * and try each requested date until one yields bookable slots.
   *
   * Steps: open the calendar once to read which dates Resy marks available,
   * intersect that with `desiredDates` (skipping ones Resy shows as unavailable
   * to avoid wasted clicks), then for each surviving date reopen the calendar,
   * click the date, wait for the slot list to re-render, and — on the first date
   * with real slots — click the slot and Reserve button. Returns on the first
   * successful reservation; `false` if none of the dates pan out.
   *
   * `desiredDates` are YYYY-MM-DD strings matched against calendar cells parsed
   * by `parseResyDateLabel`.
   */
  public async tryMultipleDates(desiredDates: string[]): Promise<boolean> {
    console.log('Starting multi-date search for Resy');
    console.log(`Desired dates: ${desiredDates.join(', ')}`);

    // Open the calendar to see available dates
    const calendarOpened = await this.openCalendar();
    if (!calendarOpened) {
      console.error('Failed to open calendar');
      return false;
    }

    // Get available dates from the calendar
    const availableDates = await this.getAvailableDatesFromCalendar();
    console.log(`Available dates from calendar: ${availableDates.join(', ')}`);

    // Close calendar before trying dates
    await this.closeCalendar();

    // Filter desired dates to only include available ones
    const datesToTry = desiredDates.filter(d => availableDates.includes(d));

    if (datesToTry.length === 0) {
      console.log('No available dates to try from the desired list');
      return false;
    }

    console.log(`Will try these available dates: ${datesToTry.join(', ')}`);

    // Try each available date in sequence
    for (let i = 0; i < datesToTry.length; i++) {
      const date = datesToTry[i];
      console.log(`Trying date ${i + 1}/${datesToTry.length}: ${date}`);

      // Open calendar and click the date
      await this.openCalendar();
      await this.wait(500);

      const clicked = await this.clickCalendarDate(date);
      if (!clicked) {
        console.log(`Failed to click date ${date}, skipping`);
        continue;
      }

      // Wait for calendar to close and time slots to reload
      await this.wait(2000);

      // Check if time slots container is available
      const hasTimeSlots = await this.waitForTimeSlots(5000);
      if (!hasTimeSlots) {
        console.log(`No time slots container after clicking date ${date}`);
        continue;
      }

      // Check for actual time slot buttons (not just the Notify button)
      const container = document.querySelector('[data-test-id="reservation-button-test-list"]');
      const timeButtons = container?.querySelectorAll('button:not([data-testid="ReservationButtonList__notify-button"])');

      if (!timeButtons || timeButtons.length === 0) {
        console.log(`No time slot buttons for date ${date}`);
        continue;
      }

      // We found availability! Try to click a time slot
      console.log(`Found ${timeButtons.length} time slot buttons for date ${date}!`);
      const slotClicked = await this.clickTimeSlot();
      if (slotClicked) {
        // Wait for modal to appear after clicking time slot
        console.log('Waiting for reservation modal to load...');
        await this.wait(1500);

        // Try to click Reserve button
        const reserved = await this.clickReserveButton();
        if (reserved) {
          console.log(`Successfully reserved for date ${date}!`);
          return true;
        }
      }
    }

    console.log('Failed to find availability on any of the desired dates');
    return false;
  }

  /**
   * Click the date-selector dropdown and confirm the calendar container
   * rendered. Returns `false` if either the trigger button or the resulting
   * `.VenuePage__Calendar-Container` is absent. The 500ms wait covers the
   * dropdown's open animation before we probe for the container.
   */
  private async openCalendar(): Promise<boolean> {
    const dateButton = document.querySelector('[data-test-id="dropdown-group-date-selector"]') as HTMLElement;
    if (!dateButton) {
      console.error('Date dropdown button not found');
      return false;
    }

    dateButton.click();
    await this.wait(500);

    // Check if calendar is now visible
    const calendar = document.querySelector('.VenuePage__Calendar-Container');
    return calendar !== null;
  }

  /**
   * Dismiss the calendar via its close button if present. Best-effort: a missing
   * button is a silent no-op (the calendar may already be closed).
   */
  private async closeCalendar(): Promise<void> {
    const closeButton = document.querySelector('[data-test-id="day-picker-close"]') as HTMLElement;
    if (closeButton) {
      closeButton.click();
      await this.wait(300);
    }
  }

  /**
   * Read the currently-open calendar and return the bookable dates as
   * YYYY-MM-DD strings. Only cells carrying the `.ResyCalendar-day--available`
   * class are considered; each date is recovered from the cell's `aria-label`
   * (e.g. "Tuesday, November 11, 2025.") via `parseResyDateLabel`. Assumes the
   * calendar is already open (caller must `openCalendar` first).
   */
  private async getAvailableDatesFromCalendar(): Promise<string[]> {
    const availableDates: string[] = [];

    // Find all available date buttons
    const availableButtons = document.querySelectorAll('.ResyCalendar-day--available');

    console.log(`Found ${availableButtons.length} available date buttons in calendar`);

    availableButtons.forEach((button) => {
      const ariaLabel = button.getAttribute('aria-label');
      if (ariaLabel) {
        // Parse date from aria-label like "Tuesday, November 11, 2025."
        const date = this.parseResyDateLabel(ariaLabel);
        if (date) {
          availableDates.push(date);
        }
      }
    });

    return availableDates;
  }

  /**
   * Click the available calendar cell matching `date` (YYYY-MM-DD). Scans the
   * available cells, comparing each parsed `aria-label` against the target;
   * returns `false` if no available cell matches (e.g. the date exists but is
   * sold out, so it lacks the `--available` class). Assumes the calendar is open.
   */
  private async clickCalendarDate(date: string): Promise<boolean> {
    // Find the button with matching date
    const availableButtons = document.querySelectorAll('.ResyCalendar-day--available');

    for (const button of Array.from(availableButtons)) {
      const ariaLabel = button.getAttribute('aria-label');
      if (ariaLabel) {
        const buttonDate = this.parseResyDateLabel(ariaLabel);
        if (buttonDate === date) {
          console.log(`Clicking calendar date: ${date}`);
          (button as HTMLElement).click();
          return true;
        }
      }
    }

    console.error(`Could not find calendar button for date: ${date}`);
    return false;
  }

  /**
   * Wait for and click the final "Reserve Now" button, retrying until success
   * or `timeout`.
   *
   * The button almost always lives inside the cross-origin widgets.resy.com
   * iframe, which this top-frame script cannot reach into. So the strategy is:
   *  1. Cheaply check the main page first (rare, but covers non-iframe layouts).
   *  2. Otherwise send a `CLICK_RESERVE_BUTTON` runtime message; the content
   *     script injected into the widgets.resy.com iframe performs the actual
   *     click and replies `{ success }`. On a not-yet-ready reply or a
   *     `chrome.runtime.lastError` (iframe listener not mounted yet) we retry
   *     after 500ms.
   *
   * A MutationObserver on the top document also re-drives the attempt whenever
   * the modal/iframe host mutates. The `resolved` guard ensures we settle the
   * promise exactly once across the observer, the async message callbacks, the
   * retry timers, and the final timeout — otherwise late callbacks could
   * resolve a promise the timeout already rejected.
   */
  private async clickReserveButton(timeout = 15000): Promise<boolean> {
    console.log('=== Starting clickReserveButton ===');
    console.log(`Looking for Reserve Now button (timeout: ${timeout}ms)`);

    return new Promise((resolve) => {
      const startTime = Date.now();
      let resolved = false;

      const tryClickButton = () => {
        if (resolved) return;

        const elapsed = Date.now() - startTime;
        if (elapsed > timeout) {
          if (!resolved) {
            resolved = true;
            console.error('=== TIMEOUT: Reserve Now button not found/clicked ===');
            resolve(false);
          }
          return;
        }

        console.log(`[${elapsed}ms] Attempting to click Reserve button...`);

        // First, check if button exists in main page (unlikely, but check anyway).
        // `offsetParent !== null` is a cheap visibility test — it excludes a
        // button that's present but display:none / detached, which we must not click.
        const buttonInMain = document.querySelector('[data-test-id="order_summary_page-button-book"]') as HTMLElement;
        if (buttonInMain && buttonInMain.offsetParent !== null) {
          console.log('Found Reserve button in main page, clicking...');
          buttonInMain.click();
          if (!resolved) {
            resolved = true;
            resolve(true);
          }
          return;
        }

        // Button is most likely in the widgets.resy.com iframe
        // Send message to iframe content script to click it
        console.log('Sending CLICK_RESERVE_BUTTON message to iframe...');
        chrome.runtime.sendMessage(
          { type: 'CLICK_RESERVE_BUTTON' },
          (response) => {
            if (chrome.runtime.lastError) {
              console.log('Chrome runtime error:', chrome.runtime.lastError.message);
              // Keep trying
              setTimeout(tryClickButton, 500);
              return;
            }

            if (response?.success) {
              console.log('=== SUCCESS: Reserve button clicked in iframe ===');
              if (!resolved) {
                resolved = true;
                resolve(true);
              }
            } else {
              console.log('Button not found in iframe yet, will retry...', response?.error || '');
              // Keep trying
              setTimeout(tryClickButton, 500);
            }
          }
        );
      };

      // Set up MutationObserver to detect when modal/iframe appears
      const observer = new MutationObserver(() => {
        if (!resolved) {
          tryClickButton();
        } else {
          observer.disconnect();
        }
      });

      observer.observe(document.body, { childList: true, subtree: true });
      console.log('MutationObserver started, watching for modal/iframe');

      // Try immediately
      tryClickButton();

      // Timeout handler
      setTimeout(() => {
        observer.disconnect();
        if (!resolved) {
          resolved = true;
          console.error('=== TIMEOUT: Reserve button not clicked within timeout ===');
          resolve(false);
        }
      }, timeout);
    });
  }

  /**
   * Parse a Resy calendar `aria-label` into a YYYY-MM-DD string.
   * Input: "Tuesday, November 11, 2025." → Output: "2025-11-11".
   *
   * Strips the leading weekday and trailing period, then lets the native `Date`
   * parser handle "November 11, 2025". Building the result from local
   * getFullYear/getMonth/getDate (rather than toISOString) keeps it in the
   * browser's local timezone, matching how the desired-date strings are
   * expressed and avoiding a UTC off-by-one day. Returns `null` on unparseable
   * input so callers can skip bad cells.
   */
  private parseResyDateLabel(label: string): string | null {
    try {
      // Remove the day of week and trailing period
      const cleaned = label.replace(/^[A-Za-z]+,\s*/, '').replace(/\.$/, '');

      // Parse "November 11, 2025"
      const date = new Date(cleaned);

      if (isNaN(date.getTime())) {
        return null;
      }

      const year = date.getFullYear();
      const month = String(date.getMonth() + 1).padStart(2, '0');
      const day = String(date.getDate()).padStart(2, '0');

      return `${year}-${month}-${day}`;
    } catch (error) {
      console.error('Error parsing Resy date label:', label, error);
      return null;
    }
  }

  /**
   * Parse a 24-hour "HH:MM" preference string to minutes-since-midnight, the
   * common unit `clickTimeSlot` uses to compare against slot times.
   */
  private parseTimeToMinutes(time: string): number {
    const [hours, minutes] = time.split(':').map(Number);
    return hours * 60 + minutes;
  }

  /**
   * Parse a 12-hour slot label (e.g. "5:30 PM") to minutes-since-midnight,
   * applying the AM/PM 24-hour conversion (12 AM → 0, 12 PM → 12). Returns 0 on
   * an unparseable string — a benign fallback since such buttons are filtered
   * out upstream by the regex match in `clickTimeSlot`.
   */
  private parse12HourTimeToMinutes(time: string): number {
    const match = time.match(/(\d{1,2}):(\d{2})\s*(AM|PM)/i);
    if (!match) {
      return 0;
    }

    let hours = parseInt(match[1], 10);
    const minutes = parseInt(match[2], 10);
    const period = match[3].toUpperCase();

    // Convert to 24-hour format
    if (period === 'PM' && hours !== 12) {
      hours += 12;
    } else if (period === 'AM' && hours === 12) {
      hours = 0;
    }

    return hours * 60 + minutes;
  }

  /** Promise-based sleep used to pace UI interactions (dropdown/animation/reload settling). */
  private wait(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}
