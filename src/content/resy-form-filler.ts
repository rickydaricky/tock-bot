import { FormFillerOptions, TockPreferences } from '../types';

export class ResyFormFiller {
  private preferences: TockPreferences;
  private waitForForm: boolean;
  private autoSubmit: boolean;

  constructor(options: FormFillerOptions) {
    this.preferences = options.preferences;
    this.waitForForm = options.waitForForm ?? true;
    this.autoSubmit = options.autoSubmit ?? true;
  }

  /**
   * Main entry point for filling the Resy reservation form
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

      // Check if actual time slot buttons are present (not just the Notify button)
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
   * Wait for time slots container to appear
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
   * Click a time slot that matches or is closest to the preferred time
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
   * Try multiple dates from the desired dates list
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
   * Open the calendar by clicking the date dropdown button
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
   * Close the calendar
   */
  private async closeCalendar(): Promise<void> {
    const closeButton = document.querySelector('[data-test-id="day-picker-close"]') as HTMLElement;
    if (closeButton) {
      closeButton.click();
      await this.wait(300);
    }
  }

  /**
   * Get available dates from the Resy calendar
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
   * Click a specific date in the calendar
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
   * Wait for and click the Reserve Now button
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

        // First, check if button exists in main page (unlikely, but check anyway)
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
   * Parse Resy date label to YYYY-MM-DD format
   * Input: "Tuesday, November 11, 2025."
   * Output: "2025-11-11"
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
   * Parse time in HH:MM format to minutes since midnight
   */
  private parseTimeToMinutes(time: string): number {
    const [hours, minutes] = time.split(':').map(Number);
    return hours * 60 + minutes;
  }

  /**
   * Parse 12-hour time (e.g., "5:30 PM") to minutes since midnight
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

  /**
   * Utility wait function
   */
  private wait(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}
