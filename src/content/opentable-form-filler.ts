import { FormFillerOptions, TockPreferences } from '../types';

export class OpenTableFormFiller {
  private preferences: TockPreferences;
  private waitForForm: boolean;
  private autoSubmit: boolean;
  private attempts: number = 0;
  private maxAttempts: number = 10;

  constructor(options: FormFillerOptions) {
    this.preferences = options.preferences;
    this.waitForForm = options.waitForForm ?? true;
    this.autoSubmit = options.autoSubmit ?? true;
  }

  /**
   * Fill the OpenTable reservation form with the provided preferences
   */
  public async fill(): Promise<boolean> {
    try {
      console.log(`Starting OpenTable form fill with preferences:`, this.preferences);

      // Wait for form elements to be available
      if (this.waitForForm) {
        const success = await this.waitForFormElements();
        if (!success) {
          console.error('Could not find OpenTable form elements after multiple attempts');
          return false;
        }
      }

      // Fill party size
      await this.fillPartySize();

      // Fill date
      await this.fillDate();

      // Fill time if time picker is available
      await this.fillTime();

      // OpenTable automatically shows available time slots - no search button needed
      console.log('Form filled. OpenTable will automatically display available time slots.');

      // If autoSubmit is true, wait for and click a time slot
      if (this.autoSubmit) {
        console.log('Auto-submit enabled, waiting for time slots...');
        const slotClicked = await this.waitForAndClickTimeSlot();
        if (slotClicked) {
          console.log('Successfully clicked a time slot!');
        } else {
          console.log('Could not find or click a time slot.');
        }
      }

      return true;
    } catch (error) {
      console.error('Error filling OpenTable form:', error);
      return false;
    }
  }

  /**
   * Wait for form elements to be available in the DOM
   */
  private async waitForFormElements(): Promise<boolean> {
    return new Promise((resolve) => {
      const checkForElements = () => {
        this.attempts++;

        const partySizePicker = document.querySelector('[data-testid="bookable-restaurant-profile-party-size-picker"]');
        const dayPicker = document.querySelector('[data-testid="bookable-restaurant-profile-day-picker"]');

        if (partySizePicker && dayPicker) {
          resolve(true);
        } else if (this.attempts >= this.maxAttempts) {
          resolve(false);
        } else {
          setTimeout(checkForElements, 500);
        }
      };

      checkForElements();
    });
  }

  /**
   * Fill party size dropdown
   */
  private async fillPartySize(): Promise<void> {
    // Use the actual select element (hidden behind the overlay)
    const select = document.querySelector('#restaurantProfileDtpPartySizePicker') as HTMLSelectElement;
    if (!select) {
      console.error('Party size picker not found');
      return;
    }

    console.log(`Setting party size to ${this.preferences.partySize}`);
    select.value = this.preferences.partySize.toString();

    // Trigger both input and change events for React compatibility
    const inputEvent = new Event('input', { bubbles: true, cancelable: true });
    const changeEvent = new Event('change', { bubbles: true, cancelable: true });
    select.dispatchEvent(inputEvent);
    select.dispatchEvent(changeEvent);

    // Small delay to let the change propagate
    await new Promise(r => setTimeout(r, 300));
  }

  /**
   * Fill date picker
   */
  private async fillDate(): Promise<void> {
    console.log(`Setting date to ${this.preferences.date}`);

    // Click the date picker overlay to open the calendar
    const dayPickerOverlay = document.querySelector('[data-testid="day-picker-overlay"]') as HTMLElement;
    if (!dayPickerOverlay) {
      console.error('Date picker overlay not found');
      return;
    }

    dayPickerOverlay.click();

    // Wait for calendar to open
    await new Promise(r => setTimeout(r, 500));

    // Parse the target date (timezone-safe)
    // Split "YYYY-MM-DD" and create date in local timezone to avoid off-by-one errors
    const [year, month, day] = this.preferences.date.split('-').map(Number);
    const targetDate = new Date(year, month - 1, day); // month is 0-indexed in JavaScript
    const targetMonth = targetDate.getMonth();
    const targetYear = targetDate.getFullYear();
    const targetDay = targetDate.getDate();

    // Navigate to the correct month if needed
    await this.navigateToMonth(targetMonth, targetYear);

    // Find and click the date button
    await this.clickDateInCalendar(targetDay, targetMonth, targetYear);

    // Small delay after selecting date
    await new Promise(r => setTimeout(r, 300));
  }

  /**
   * Navigate calendar to the target month
   */
  private async navigateToMonth(targetMonth: number, targetYear: number): Promise<void> {
    let attempts = 0;
    const maxMonthNavAttempts = 12; // Don't navigate more than 12 months

    while (attempts < maxMonthNavAttempts) {
      // Get current displayed month from the calendar header
      const monthHeader = document.querySelector('.rdp-caption [aria-live="polite"]');
      if (!monthHeader) {
        console.error('Could not find calendar month header');
        return;
      }

      const headerText = monthHeader.textContent || '';
      const currentDate = new Date(headerText + ' 1');
      const currentMonth = currentDate.getMonth();
      const currentYear = currentDate.getFullYear();

      // Check if we're at the target month
      if (currentMonth === targetMonth && currentYear === targetYear) {
        console.log(`Navigated to target month: ${headerText}`);
        break;
      }

      // Determine if we need to go forward or backward
      const targetDateObj = new Date(targetYear, targetMonth, 1);
      const currentDateObj = new Date(currentYear, currentMonth, 1);

      if (targetDateObj > currentDateObj) {
        // Need to go forward
        const nextButton = document.querySelector('[name="next-month"]') as HTMLButtonElement;
        if (nextButton && !nextButton.disabled) {
          nextButton.click();
          await new Promise(r => setTimeout(r, 300));
        } else {
          console.log('Cannot navigate forward (button disabled or not found)');
          break;
        }
      } else {
        // Need to go backward
        const prevButton = document.querySelector('[name="previous-month"]') as HTMLButtonElement;
        if (prevButton && !prevButton.disabled) {
          prevButton.click();
          await new Promise(r => setTimeout(r, 300));
        } else {
          console.log('Cannot navigate backward (button disabled or not found)');
          break;
        }
      }

      attempts++;
    }
  }

  /**
   * Click the date in the calendar
   */
  private async clickDateInCalendar(targetDay: number, targetMonth: number, targetYear: number): Promise<void> {
    // OpenTable uses react-day-picker with aria-labels
    // Use aria-label for reliable date selection (e.g., "Friday, November 21")
    const monthNames = ['January', 'February', 'March', 'April', 'May', 'June',
                        'July', 'August', 'September', 'October', 'November', 'December'];
    const dayNames = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

    const targetDate = new Date(targetYear, targetMonth, targetDay);
    const dayName = dayNames[targetDate.getDay()];
    const monthName = monthNames[targetMonth];
    const expectedAriaLabel = `${dayName}, ${monthName} ${targetDay}`;

    console.log(`Looking for date button with aria-label: ${expectedAriaLabel}`);

    // Try to find button by aria-label (most reliable)
    const dateButton = document.querySelector(`button[aria-label="${expectedAriaLabel}"]`) as HTMLButtonElement;

    if (dateButton) {
      console.log(`Clicking date: ${expectedAriaLabel}`);
      dateButton.click();
      return;
    }

    // Fallback: try text matching (less reliable but better than nothing)
    console.warn(`Could not find button with aria-label "${expectedAriaLabel}", trying text matching fallback`);
    const dayButtons = document.querySelectorAll('.rdp-day:not(.rdp-day_disabled)');

    for (const button of Array.from(dayButtons)) {
      const buttonElement = button as HTMLButtonElement;
      const buttonText = buttonElement.textContent?.trim();

      if (buttonText === targetDay.toString()) {
        console.log(`Clicking date using fallback method: ${targetDay}`);
        buttonElement.click();
        return;
      }
    }

    console.error(`Could not find date button for day ${targetDay} using any method`);
  }

  /**
   * Fill time picker (if available)
   */
  private async fillTime(): Promise<void> {
    console.log(`Setting time to ${this.preferences.time}`);

    // Try to find the time picker select element
    // Following the pattern of party size: #restaurantProfileDtpPartySizePicker
    const timePicker = document.querySelector('#restaurantProfileDtpTimePicker') as HTMLSelectElement;

    if (!timePicker) {
      // Time picker not found - try alternative selectors
      console.warn('Time picker with ID #restaurantProfileDtpTimePicker not found');

      // Debug: Log all select elements to help identify the time picker
      const allSelects = document.querySelectorAll('select');
      console.log(`Found ${allSelects.length} select elements on page:`);
      allSelects.forEach((select, index) => {
        console.log(`  Select ${index}: id="${select.id}", name="${select.getAttribute('name')}", aria-label="${select.getAttribute('aria-label')}"`);
      });

      // Try finding by aria-label or data-test attribute
      const timePickerAlt = document.querySelector('select[aria-label*="time" i], select[aria-label*="Time" i], select[data-test*="time"]') as HTMLSelectElement;

      if (timePickerAlt) {
        console.log('Found alternative time picker:', timePickerAlt.id || timePickerAlt.getAttribute('data-test'));
        await this.setTimeValue(timePickerAlt);
      } else {
        console.error('Could not find time picker element using any selector');
      }
      return;
    }

    await this.setTimeValue(timePicker);
  }

  /**
   * Set the time value in the time picker select element
   */
  private async setTimeValue(timeSelect: HTMLSelectElement): Promise<void> {
    // Convert 24-hour time (17:30) to 12-hour format for matching
    const [hours, minutes] = this.preferences.time.split(':').map(Number);
    const period = hours >= 12 ? 'PM' : 'AM';
    const hours12 = hours % 12 || 12;
    const time12Hour = `${hours12}:${minutes.toString().padStart(2, '0')} ${period}`;
    const time12HourAlt = `${hours12}:${minutes.toString().padStart(2, '0')}${period}`; // No space variant

    console.log(`Looking for time: ${this.preferences.time} (24hr) = ${time12Hour} or ${time12HourAlt} (12hr)`);

    // Log all available options
    console.log(`Time picker has ${timeSelect.options.length} options:`);
    for (let i = 0; i < Math.min(timeSelect.options.length, 10); i++) {
      console.log(`  Option ${i}: value="${timeSelect.options[i].value}", text="${timeSelect.options[i].text}"`);
    }

    // Try to find exact match first
    let matchedIndex = -1;
    for (let i = 0; i < timeSelect.options.length; i++) {
      const optionText = timeSelect.options[i].text.trim();
      const optionValue = timeSelect.options[i].value.trim();

      if (optionText === time12Hour || optionText === time12HourAlt ||
          optionValue === time12Hour || optionValue === time12HourAlt ||
          optionText === this.preferences.time || optionValue === this.preferences.time) {
        matchedIndex = i;
        console.log(`Found exact match at index ${i}: "${optionText}"`);
        break;
      }
    }

    // If no exact match, find closest time
    if (matchedIndex === -1) {
      console.warn(`No exact match found for ${time12Hour}, finding closest time...`);
      const targetMinutes = hours * 60 + minutes;
      let closestDiff = Infinity;

      for (let i = 0; i < timeSelect.options.length; i++) {
        const optionText = timeSelect.options[i].text.trim();
        // Try to parse the time from option text
        const timeMatch = optionText.match(/(\d{1,2}):(\d{2})\s*(AM|PM)/i);
        if (timeMatch) {
          let optionHours = parseInt(timeMatch[1]);
          const optionMinutes = parseInt(timeMatch[2]);
          const optionPeriod = timeMatch[3].toUpperCase();

          // Convert to 24-hour
          if (optionPeriod === 'PM' && optionHours !== 12) optionHours += 12;
          if (optionPeriod === 'AM' && optionHours === 12) optionHours = 0;

          const optionTotalMinutes = optionHours * 60 + optionMinutes;
          const diff = Math.abs(optionTotalMinutes - targetMinutes);

          if (diff < closestDiff) {
            closestDiff = diff;
            matchedIndex = i;
          }
        }
      }

      if (matchedIndex !== -1) {
        console.log(`Found closest match at index ${matchedIndex}: "${timeSelect.options[matchedIndex].text}"`);
      }
    }

    if (matchedIndex === -1) {
      console.error('Could not find any suitable time option');
      return;
    }

    // Set the selected index
    timeSelect.selectedIndex = matchedIndex;

    // Trigger both input and change events for React compatibility
    const inputEvent = new Event('input', { bubbles: true, cancelable: true });
    const changeEvent = new Event('change', { bubbles: true, cancelable: true });
    timeSelect.dispatchEvent(inputEvent);
    timeSelect.dispatchEvent(changeEvent);

    console.log(`Time picker set to: "${timeSelect.options[matchedIndex].text}"`);

    // Small delay to let the change propagate and time slots update
    await new Promise(r => setTimeout(r, 300));
  }

  /**
   * Find and return the clickable button element for the time slot that best matches the preferred time
   */
  private findMatchingTimeSlot(preferredTime: string): HTMLElement | null {
    // Look for time slot list items
    const timeSlots = document.querySelectorAll('[data-testid^="time-slot-"]');

    if (timeSlots.length === 0) {
      return null;
    }

    console.log(`Found ${timeSlots.length} time slot(s)`);

    // Convert preferred time to 12-hour format for matching
    const [hours, minutes] = preferredTime.split(':').map(Number);
    const period = hours >= 12 ? 'PM' : 'AM';
    const hours12 = hours % 12 || 12;
    const targetTime = `${hours12}:${minutes.toString().padStart(2, '0')} ${period}`;
    const targetMinutes = hours * 60 + minutes;

    console.log(`Looking for time slot matching: ${targetTime} (from ${preferredTime})`);

    let bestMatch: { button: HTMLElement; diff: number; timeText: string } | null = null;

    // Iterate through all time slots to find best match
    for (const slot of Array.from(timeSlots)) {
      const button = slot.querySelector('[role="button"]') as HTMLElement;
      if (!button) continue;

      const buttonText = button.textContent?.trim() || '';
      const ariaLabel = button.getAttribute('aria-label') || '';

      // Extract time from button text (e.g., "5:30 PM*" -> "5:30 PM")
      const timeMatch = buttonText.match(/(\d{1,2}):(\d{2})\s*(AM|PM)/i);
      if (!timeMatch) {
        console.warn(`Could not parse time from button text: "${buttonText}"`);
        continue;
      }

      const slotTime = `${timeMatch[1]}:${timeMatch[2]} ${timeMatch[3].toUpperCase()}`;

      // Check for exact match
      if (slotTime === targetTime) {
        console.log(`Found exact time match: ${slotTime}`);
        console.log(`  Button text: "${buttonText}", aria-label: "${ariaLabel}"`);
        return button;
      }

      // Calculate time difference for closest match
      let slotHours = parseInt(timeMatch[1]);
      const slotMinutes = parseInt(timeMatch[2]);
      const slotPeriod = timeMatch[3].toUpperCase();

      // Convert to 24-hour for comparison
      if (slotPeriod === 'PM' && slotHours !== 12) slotHours += 12;
      if (slotPeriod === 'AM' && slotHours === 12) slotHours = 0;

      const slotTotalMinutes = slotHours * 60 + slotMinutes;
      const diff = Math.abs(slotTotalMinutes - targetMinutes);

      if (!bestMatch || diff < bestMatch.diff) {
        bestMatch = { button, diff, timeText: slotTime };
      }
    }

    if (bestMatch) {
      const buttonText = bestMatch.button.textContent?.trim();
      const ariaLabel = bestMatch.button.getAttribute('aria-label');
      console.log(`No exact match found. Closest time slot: ${bestMatch.timeText} (${bestMatch.diff} minutes difference)`);
      console.log(`  Button text: "${buttonText}", aria-label: "${ariaLabel}"`);
      return bestMatch.button;
    }

    console.warn('No suitable time slot found');
    return null;
  }

  /**
   * Wait for time slot buttons to appear and click one
   */
  private async waitForAndClickTimeSlot(): Promise<boolean> {
    console.log('Waiting for time slots to appear...');

    this.attempts = 0;
    let resolved = false; // Track if promise has been resolved

    return new Promise((resolve) => {
      // Store timeout ID so we can clear it later
      let timeoutId: ReturnType<typeof setTimeout> | null = null;

      // Helper to resolve only once
      const resolveOnce = (value: boolean) => {
        if (!resolved) {
          resolved = true;
          observer.disconnect();
          if (timeoutId !== null) {
            clearTimeout(timeoutId);
          }
          resolve(value);
        }
      };

      // Use MutationObserver to detect when time slots are added
      const observer = new MutationObserver(() => {
        if (resolved) return; // Skip if already resolved

        const button = this.findMatchingTimeSlot(this.preferences.time);
        if (button) {
          console.log('Time slot button found via MutationObserver');
          console.log(`Attempting to click button at position: top=${button.getBoundingClientRect().top}, left=${button.getBoundingClientRect().left}`);
          console.log(`Button is visible: ${button.offsetParent !== null}, disabled: ${button.hasAttribute('disabled')}`);

          button.click();
          console.log('Click event dispatched to time slot button');
          resolveOnce(true);
        }
      });

      // Observe the document body for added time slot elements
      observer.observe(document.body, {
        childList: true,
        subtree: true
      });

      // Also poll for time slots as a fallback
      const checkForTimeSlots = () => {
        if (resolved) return; // Skip if already resolved

        this.attempts++;

        const button = this.findMatchingTimeSlot(this.preferences.time);

        if (button) {
          console.log('Time slot button found via polling');
          console.log(`Attempting to click button at position: top=${button.getBoundingClientRect().top}, left=${button.getBoundingClientRect().left}`);
          console.log(`Button is visible: ${button.offsetParent !== null}, disabled: ${button.hasAttribute('disabled')}`);

          button.click();
          console.log('Click event dispatched to time slot button');
          resolveOnce(true);
        } else if (this.attempts >= this.maxAttempts) {
          console.log('No time slots found after maximum attempts');
          resolveOnce(false);
        } else {
          console.log(`Time slots not found yet, attempt ${this.attempts}/${this.maxAttempts}`);
          setTimeout(checkForTimeSlots, 500); // Faster polling - 500ms instead of 1000ms
        }
      };

      checkForTimeSlots();

      // Set a maximum timeout of 30 seconds
      timeoutId = setTimeout(() => {
        if (!resolved) {
          console.log('Timeout reached waiting for time slots (30 seconds)');
          resolveOnce(false);
        }
      }, 10000);
    });
  }
}
