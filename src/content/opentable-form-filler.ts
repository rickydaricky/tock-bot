/**
 * OpenTable checkout form-filler content script.
 *
 * Single responsibility: given a set of reservation preferences (party size, date,
 * time), drive OpenTable's restaurant-profile date/time/party-size picker in the DOM
 * and — when auto-submit is on — click the matching availability time slot to advance
 * toward checkout.
 *
 * Role in the system: this is the OpenTable-specific sibling of `form-filler.ts` (Tock)
 * and `resy-form-filler.ts` (Resy). Because OpenTable renders its own on-page widgets
 * (no cross-origin Stripe iframe at this stage), everything here works by directly
 * mutating native `<select>` elements and clicking calendar/slot buttons, then
 * dispatching synthetic `input`/`change` events so React re-renders. Unlike the Tock
 * path, no AppleScript/cliclick server is needed to fill these fields.
 *
 * Key OpenTable DOM facts this relies on (reverse-engineered, brittle by nature):
 *  - The party-size and time pickers are real `<select>` elements hidden behind
 *    styled overlays, addressable by fixed ids (`#restaurantProfileDtpPartySizePicker`,
 *    `#restaurantProfileDtpTimePicker`). We set `.value`/`.selectedIndex` on the hidden
 *    select rather than clicking the overlay.
 *  - The date picker is a react-day-picker calendar; days are addressed by their
 *    human `aria-label` (e.g. "Friday, November 21"), which is the most stable handle.
 *  - Availability appears as `[data-testid^="time-slot-"]` items containing a
 *    `[role="button"]`; OpenTable shows these automatically once date/time/party are
 *    set — there is no explicit "search" button to click.
 *
 * Key export: {@link OpenTableFormFiller}.
 */
import { FormFillerOptions, TockPreferences } from '../types';
import { setOtBookingFlag, clearOtBookingFlag, OtBookingFlag } from '../utils/storage';

/**
 * Fills and (optionally) submits OpenTable's on-page reservation picker.
 *
 * Construct with the user's {@link FormFillerOptions} and call {@link fill}. The class
 * is single-use per page: it holds mutable `attempts` state shared across the DOM-poll
 * loops, so create a fresh instance rather than re-running `fill()` on the same object.
 */
export class OpenTableFormFiller {
  private preferences: TockPreferences;
  private waitForForm: boolean;
  private autoSubmit: boolean;
  /**
   * Shared retry counter, reused (and reset) by both `waitForFormElements()` and
   * `waitForAndClickTimeSlot()`. It is intentionally an instance field so those polling
   * loops don't each thread a counter through their recursive setTimeout callbacks.
   */
  private attempts: number = 0;
  /** Cap on poll iterations for both the form-ready wait and the time-slot wait. */
  private maxAttempts: number = 10;

  constructor(options: FormFillerOptions) {
    this.preferences = options.preferences;
    // Default both behaviours on: callers usually want to wait for the widget to hydrate
    // and to auto-click a slot. Pass `false` explicitly to only populate fields.
    this.waitForForm = options.waitForForm ?? true;
    this.autoSubmit = options.autoSubmit ?? true;
  }

  /**
   * Orchestrates the full fill: wait for the widget (optional) → set party size → set
   * date → set time → optionally click the best-matching availability slot.
   *
   * Ordering matters: party size and date must be committed before time slots are
   * meaningful, since OpenTable recomputes availability from those inputs. Returns
   * `true` if the form was filled without throwing (note: a `true` here does NOT
   * guarantee a slot was clicked — that outcome is logged separately). Any thrown
   * error is caught and surfaced as `false` so a broken selector never crashes the
   * host page.
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
        // Arm cross-page completion ONLY when the user opted into auto-purchase. Without this flag the
        // /booking/details page does nothing automatically (user completes by hand — the safe default).
        if (this.preferences.autoPurchaseEnabled) {
          await setOtBookingFlag({ until: Date.now() + 120000, maxPriceCents: this.preferences.maxPriceCents });
          console.log('OT: armed auto-complete for the booking-details page (autoPurchase on)');
        }
        console.log('Auto-submit enabled, waiting for time slots...');
        const slotClicked = await this.waitForAndClickTimeSlot();
        if (slotClicked) {
          console.log('Successfully clicked a time slot!');
        } else {
          console.log('Could not find or click a time slot.');
          await clearOtBookingFlag(); // nothing to complete; don't leave the flag armed
        }
      }

      return true;
    } catch (error) {
      console.error('Error filling OpenTable form:', error);
      return false;
    }
  }

  /**
   * Poll (up to `maxAttempts` × 500ms) until both the party-size and day pickers exist.
   *
   * OpenTable's profile page is a React SPA that hydrates asynchronously, so the pickers
   * are not present at content-script injection time. We gate on the two `data-testid`
   * anchors that wrap the real inputs; once both are in the DOM the widget is considered
   * interactive. Resolves `false` (rather than rejecting) if the widget never appears.
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
   * Set the party-size `<select>` to the preferred size and notify React.
   *
   * We mutate the real (visually hidden) native select rather than clicking the styled
   * overlay, then dispatch both `input` and `change` — React's controlled-select
   * bindings listen for these and won't observe a programmatic `.value` assignment on
   * their own. The 300ms settle lets the re-render land before the next field is set.
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
   * Open the react-day-picker calendar, navigate to the target month, and click the day.
   *
   * `preferences.date` is a "YYYY-MM-DD" string. It is parsed into a local-timezone
   * `Date` via explicit year/month/day args (NOT `new Date("YYYY-MM-DD")`, which parses
   * as UTC midnight and can render as the previous day in western timezones) — this is
   * the off-by-one guard called out below.
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
   * Step the calendar's prev/next-month buttons until the header shows the target month.
   *
   * The currently displayed month is read from the `aria-live` header text (e.g.
   * "November 2025") and parsed via `new Date(headerText + ' 1')` to get a comparable
   * month/year. Direction is chosen by comparing first-of-month `Date` objects, so it
   * works across year boundaries. Bails out early if a nav button is missing/disabled
   * (target is outside OpenTable's bookable window) or after `maxMonthNavAttempts` to
   * avoid an infinite loop if the header never advances.
   */
  private async navigateToMonth(targetMonth: number, targetYear: number): Promise<void> {
    let attempts = 0;
    // 12 = one full year of forward/back clicks; OpenTable never books further out, so
    // exceeding this means the target is unreachable and we should stop rather than spin.
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
   * Click the day cell for the target date within the currently displayed month.
   *
   * Primary strategy: match on the day button's `aria-label`, reconstructed here as
   * `"<Weekday>, <Month> <Day>"` (e.g. "Friday, November 21") — the exact format
   * react-day-picker emits, and the most collision-proof handle (bare day numbers
   * repeat across adjacent months shown in the same grid). Falls back to matching the
   * button's text content against the day number, scoped to non-disabled `.rdp-day`
   * cells, only if the aria-label lookup misses.
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
   * Locate the time-picker `<select>` and delegate value-setting to `setTimeValue`.
   *
   * The stable id `#restaurantProfileDtpTimePicker` is tried first (mirrors the
   * party-size picker id). Not every restaurant profile renders a standalone time
   * select — when it's absent we log every `<select>` on the page for debugging, then
   * fall back to a heuristic attribute match (`aria-label`/`data-test` containing
   * "time"). If neither resolves, we return quietly; the availability slots may still
   * appear from date + party size alone.
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
   * Select the option in `timeSelect` that matches (or is closest to) the preferred time.
   *
   * Matching is two-tier because option label formatting varies by restaurant:
   *  1. Exact match against several string renderings of the preferred time — 12-hour
   *     with and without the space ("5:30 PM" / "5:30PM") plus the raw 24-hour string —
   *     checked against both option `.text` and `.value`.
   *  2. If nothing matches exactly, parse each option's "H:MM AM/PM" label into minutes
   *     and pick the option with the smallest absolute difference, so a requested 5:30
   *     still books a nearby 5:15/5:45 rather than failing.
   * After choosing, dispatch `input` + `change` so React updates and recomputes slots.
   */
  private async setTimeValue(timeSelect: HTMLSelectElement): Promise<void> {
    // Convert 24-hour time (17:30) to 12-hour format for matching
    const [hours, minutes] = this.preferences.time.split(':').map(Number);
    const period = hours >= 12 ? 'PM' : 'AM';
    // `hours % 12 || 12` maps 0→12 and 12→12 so midnight/noon render correctly in 12h.
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
      // Compare in absolute minutes-since-midnight so proximity is direction-agnostic.
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
   * Scan the rendered availability slots and return the clickable button closest to the
   * preferred time, or `null` if no slots exist yet.
   *
   * This reads the *availability results* (`[data-testid^="time-slot-"]`), which is a
   * different surface from the time `<select>` filled by `setTimeValue` — those are the
   * requested time; these are what OpenTable actually offers. Each slot's inner
   * `[role="button"]` label is parsed via a "H:MM AM/PM" regex (tolerating trailing
   * markers like the "*" on "5:30 PM*"). An exact time returns immediately; otherwise
   * the smallest minutes-difference slot is returned. Returning `null` vs a far-off
   * slot is intentional so callers can keep polling while results are still streaming in.
   */
  private findMatchingTimeSlot(preferredTime: string): HTMLElement | null {
    // Candidate slots come from two DOM shapes OpenTable uses across restaurants:
    //  (a) [data-testid^="time-slot-"] with an inner [role="button"] (e.g. Nopa)
    //  (b) <a aria-label="Reserve table at {r} at {H:MM AM/PM} on {date}, ..."> (e.g. House of Prime Rib)
    const candidates: { el: HTMLElement; timeText: string }[] = [];

    document.querySelectorAll('[data-testid^="time-slot-"]').forEach((slot) => {
      const button = slot.querySelector('[role="button"]') as HTMLElement | null;
      if (!button) return;
      const m = (button.textContent || '').match(/(\d{1,2}):(\d{2})\s*(AM|PM)/i);
      if (m) candidates.push({ el: button, timeText: `${m[1]}:${m[2]} ${m[3].toUpperCase()}` });
    });

    document.querySelectorAll('a[aria-label^="Reserve table at" i]').forEach((a) => {
      const label = a.getAttribute('aria-label') || '';
      // "...at 9:30 PM on July 16..." — take the time after " at " and before " on ".
      const m = label.match(/\bat\s+(\d{1,2}):(\d{2})\s*(AM|PM)\b/i);
      if (m) candidates.push({ el: a as HTMLElement, timeText: `${m[1]}:${m[2]} ${m[3].toUpperCase()}` });
    });

    if (candidates.length === 0) return null; // none rendered yet — keep polling

    const [h, min] = preferredTime.split(':').map(Number);
    const period = h >= 12 ? 'PM' : 'AM';
    const targetText = `${h % 12 || 12}:${String(min).padStart(2, '0')} ${period}`;
    const targetMinutes = h * 60 + min;

    const toMinutes = (t: string): number => {
      const m = t.match(/(\d{1,2}):(\d{2})\s*(AM|PM)/i);
      if (!m) return NaN;
      let hh = parseInt(m[1], 10); const mm = parseInt(m[2], 10); const p = m[3].toUpperCase();
      if (p === 'PM' && hh !== 12) hh += 12;
      if (p === 'AM' && hh === 12) hh = 0;
      return hh * 60 + mm;
    };

    const exact = candidates.find((c) => c.timeText === targetText);
    if (exact) { console.log(`OT: exact slot match ${exact.timeText}`); return exact.el; }

    let best: { el: HTMLElement; diff: number; timeText: string } | null = null;
    for (const c of candidates) {
      const diff = Math.abs(toMinutes(c.timeText) - targetMinutes);
      if (!best || diff < best.diff) best = { el: c.el, diff, timeText: c.timeText };
    }
    if (best) { console.log(`OT: closest slot ${best.timeText} (${best.diff}m off ${targetText})`); return best.el; }
    return null;
  }

  /**
   * Wait for availability slots to render, then click the best match — resolves `true`
   * once a slot is clicked, `false` if none appears before the limits are hit.
   *
   * Uses a belt-and-suspenders approach because OpenTable adds slots asynchronously and
   * inconsistently: a `MutationObserver` on `document.body` catches slots the instant
   * they're inserted, while a 500ms polling loop (capped at `maxAttempts`) covers cases
   * where the mutation fires before the button is fully ready. A hard timeout backstops
   * both. All three paths funnel through `resolveOnce`, which guarantees the promise
   * settles exactly once and tears down the observer + timeout so no stray click or
   * leaked observer fires after resolution.
   *
   * Note: `this.attempts` is reset to 0 here because it is shared with
   * `waitForFormElements` and would otherwise start near/at the cap.
   */
  private async waitForAndClickTimeSlot(): Promise<boolean> {
    console.log('Waiting for time slots to appear...');

    this.attempts = 0;
    let resolved = false; // Track if promise has been resolved

    return new Promise((resolve) => {
      // Store timeout ID so we can clear it later
      let timeoutId: ReturnType<typeof setTimeout> | null = null;

      // Single settle point: disconnects the observer and clears the timeout so the
      // three racing producers (observer, poll loop, timeout) can never double-resolve.
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

      // Hard backstop: if neither the observer nor the poll loop has resolved, give up.
      // NOTE: the actual delay is 10000ms (10s) — the "30 seconds" wording here and in
      // the log message below is stale; the effective cap is 10 seconds.
      timeoutId = setTimeout(() => {
        if (!resolved) {
          console.log('Timeout reached waiting for time slots (30 seconds)');
          resolveOnce(false);
        }
      }, 10000);
    });
  }
}

/** Parse an explicit UPFRONT charge in cents from booking-page text, or null if there's only a
 *  conditional no-show/cancellation fee (which is not an upfront charge). Fail-closed: any $ amount
 *  tied to charge/total/deposit/prepay/due counts; "no-show"/"cancellation" conditional lines do not. */
export function parseOtUpfrontChargeCents(text: string): number | null {
  const lines = (text || '').split('\n');
  let max: number | null = null;
  for (const line of lines) {
    if (/no.?show|cancellation/i.test(line)) continue; // conditional fee, not an upfront charge
    if (!/charge|total|deposit|prepay|amount due|due now|pay now/i.test(line)) continue;
    const m = line.match(/\$\s*([0-9][0-9,]*(?:\.[0-9]{2})?)/);
    if (m) {
      const cents = Math.round(parseFloat(m[1].replace(/,/g, '')) * 100);
      if (max === null || cents > max) max = cents;
    }
  }
  return max;
}

/** Complete an in-progress OpenTable booking on the /booking/details page. Fail-closed. */
export async function completeOpenTableBooking(flag: OtBookingFlag): Promise<boolean> {
  console.log('OT: completeOpenTableBooking on', location.href);
  // Wait up to 30s for the confirm button (page may still be hydrating).
  const findBtn = () => document.querySelector('[data-testid="complete-reservation-button"], #complete-reservation') as HTMLElement | null;
  let btn = findBtn();
  for (let i = 0; !btn && i < 60; i++) { await new Promise((r) => setTimeout(r, 500)); btn = findBtn(); }
  if (!btn) { console.error('OT: complete-reservation button not found'); return false; }

  // FAIL-CLOSED: a card-entry (Stripe) form means no card on file / prepaid — v1 does not fill it.
  const stripe = document.querySelector('iframe[src*="stripe" i], iframe[title*="card" i], iframe[title*="secure card" i]');
  if (stripe) { console.warn('OT: card-entry form present — aborting (fail-closed). Complete manually / add a card on file.'); return false; }

  // FAIL-CLOSED: an explicit upfront charge over the cap (or with no cap set) aborts.
  const upfront = parseOtUpfrontChargeCents(document.body.innerText || '');
  if (upfront != null && (flag.maxPriceCents == null || upfront > flag.maxPriceCents)) {
    console.warn(`OT: upfront charge $${(upfront / 100).toFixed(2)} exceeds cap (${flag.maxPriceCents == null ? 'none set' : '$' + (flag.maxPriceCents / 100).toFixed(2)}) — aborting (fail-closed).`);
    return false;
  }

  console.log('OT: clicking Complete reservation…');
  btn.click(); // invisible reCAPTCHA executes + submits in the real logged-in browser
  await new Promise((r) => setTimeout(r, 5000));
  console.log('OT: Complete reservation clicked.');
  return true;
}
