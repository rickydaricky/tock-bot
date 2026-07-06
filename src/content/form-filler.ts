/**
 * form-filler.ts — Tock checkout form-filler content script.
 *
 * Single responsibility: drive a Tock reservation from search-form fill through
 * slot booking and (optionally) auto-purchase, entirely by simulating user input
 * against Tock's live DOM. This is the browser-extension half of the project (the
 * Node/Playwright sniper server is the other); it runs inside the page as a content
 * script and has no privileged access — every interaction is a `.click()`, a
 * dispatched change event, or a coordinate handed to the local automation server.
 *
 * Pipeline (roughly the order methods fire):
 *   1. `fill()` — party size / date / time into the search form, then submit.
 *      If already on the search results URL, skips straight to booking.
 *   2. `waitForAndClickBookButton()` / `findBookButton()` — race to click the
 *      time-slot "Book" button as soon as it renders (MutationObserver + aggressive
 *      polling), matching the user's preferred time (exact, else nearest).
 *   3. `handlePurchaseFlow()` — walks the add-ons interstitials to the purchase page.
 *   4. `handlePurchaseConfirmation()` — the payoff: checks consent boxes, and because
 *      card/billing live in cross-origin Stripe iframes the content script cannot
 *      touch, hands their viewport coordinates + card details to the local
 *      AppleScript+cliclick server (localhost:3847) which types them via OS input.
 *
 * A large fraction of this file is defensive DOM heuristics: Tock ships multiple
 * calendar/date-cell shapes and re-renders slots dynamically, so many methods try a
 * cascade of selectors (strict → loose) and verify against the visible date-button
 * text rather than trusting a single query. Those quirks are reverse-engineered and
 * annotated inline where they bite.
 *
 * Key export: `TockFormFiller` (class).
 */
import { FormElements, FormFillerOptions, TockPreferences } from '../types';
import { isTockSearchUrl } from '../utils/url-builder';

/**
 * Orchestrates a single Tock reservation attempt against the live page DOM.
 *
 * One instance drives one booking: construct it with the user's `preferences`
 * (party size, date, time, and — when auto-purchase is on — card/billing details),
 * then call `fill()`. Public surface the caller (content-script entry point) uses:
 * `fill()`, `tryMultipleDates()`, and `handlePurchaseFlow()`.
 *
 * State is intentionally minimal and per-attempt: `attempts`/`maxAttempts` are the
 * shared retry budget reused across the poll loops, and `dateButtonRef` is cached so
 * date-selection code can read back the button's visible label to *verify* a click
 * actually changed the selected date (Tock's calendars can silently no-op).
 */
export class TockFormFiller {
  private preferences: TockPreferences;
  private waitForForm: boolean;
  private autoSubmit: boolean;
  private attempts: number = 0;
  private maxAttempts: number = 10;
  private dateButtonRef: HTMLElement | null = null; // Reference to the date button

  /**
   * `waitForForm` and `autoSubmit` default to true: absent an explicit opt-out we
   * assume a fully hands-off run (poll for the form, then submit and book).
   */
  constructor(options: FormFillerOptions) {
    this.preferences = options.preferences;
    this.waitForForm = options.waitForForm ?? true;
    this.autoSubmit = options.autoSubmit ?? true;
  }

  /**
   * Get the modal container if present (Tock search modal)
   * Returns null if no modal is found (e.g., on regular restaurant page)
   */
  private getModalContainer(): HTMLElement | null {
    return document.querySelector('[data-testid="in-business-search-modal"]') as HTMLElement;
  }

  /**
   * Ensure the Tock calendar dropdown is open, clicking the date button to open it
   * if needed.
   *
   * Gotcha: `.ConsumerCalendar` stays in the DOM even when the dropdown is closed,
   * so mere existence is not "open". We treat it as open only when it's both
   * CSS-visible (display/visibility/opacity) *and* has non-zero layout size — either
   * check alone gives false positives.
   */
  private async ensureCalendarIsOpen(): Promise<void> {
    // Get the root container (modal if present, otherwise document)
    const modal = this.getModalContainer();
    const root = modal || document;

    // Check if calendar is already visible
    const calendar = root.querySelector('.ConsumerCalendar') as HTMLElement;

    if (calendar) {
      // Check if calendar is actually visible (not just exists in DOM)
      const style = window.getComputedStyle(calendar);
      const isVisible = style.display !== 'none' &&
                       style.visibility !== 'hidden' &&
                       style.opacity !== '0';

      const rect = calendar.getBoundingClientRect();
      const hasSize = rect.width > 0 && rect.height > 0;
      const isOpen = isVisible && hasSize;

      if (isOpen) {
        console.log('Calendar is already open');
        return;
      }
    }

    // Calendar not visible, need to click the date button to open it
    console.log('Calendar not open, clicking date button to open it...');

    const dateButton = root.querySelector('[data-testid="reservation-date-button"]') as HTMLElement;

    if (!dateButton) {
      console.error('Could not find date button to open calendar');
      return;
    }

    // Click the date button
    dateButton.click();

    // Wait for calendar to appear
    await this.waitForCalendarToAppear();
  }

  /**
   * Wait for the calendar to appear in the DOM
   */
  private async waitForCalendarToAppear(): Promise<void> {
    const maxAttempts = 10;
    let attempts = 0;

    // Get the root container (modal if present, otherwise document)
    const modal = this.getModalContainer();
    const root = modal || document;

    while (attempts < maxAttempts) {
      const calendar = root.querySelector('.ConsumerCalendar') as HTMLElement;

      if (calendar) {
        // Check if calendar is actually visible
        const style = window.getComputedStyle(calendar);
        const isVisible = style.display !== 'none' &&
                         style.visibility !== 'hidden' &&
                         style.opacity !== '0';

        const rect = calendar.getBoundingClientRect();
        const hasSize = rect.width > 0 && rect.height > 0;
        const isOpen = isVisible && hasSize;

        if (isOpen) {
          console.log('Calendar appeared and is open');
          await new Promise(r => setTimeout(r, 200)); // Small delay for rendering
          return;
        }
      }

      await new Promise(r => setTimeout(r, 100));
      attempts++;
    }

    console.warn('Calendar did not appear after waiting');
  }

  /**
   * Get all available dates from the Tock calendar as YYYY-MM-DD strings.
   *
   * Tock's day cells carry the ISO date in `aria-label`. We probe a cascade of
   * selectors from strictest (available, in-month, not disabled/sold) to loosest
   * (any button whose aria-label mentions a "202x" year) and take the first that
   * matches anything — the strict classes aren't always present, but when they are
   * they filter out greyed-out/sold days. Results are de-duped because two month
   * panes render side by side and share boundary dates.
   */
  private async getAvailableDatesFromCalendar(): Promise<string[]> {
    const availableDates: string[] = [];

    // First, ensure the calendar is visible
    await this.ensureCalendarIsOpen();

    // Get the root container (modal if present, otherwise document)
    const modal = this.getModalContainer();
    const root = modal || document;

    // Try multiple selectors with decreasing strictness
    const selectors = [
      '.ConsumerCalendar-day.is-available.is-in-month:not(.is-disabled):not(.is-sold)',
      '.ConsumerCalendar-day.is-available:not(.is-disabled):not(.is-sold)',
      '.ConsumerCalendar-day.is-available',
      'button[aria-label*="202"]' // Fallback: matches buttons with year in aria-label
    ];

    let availableButtons: NodeListOf<Element> | null = null;

    // Try each selector until we find results
    for (const selector of selectors) {
      const buttons = root.querySelectorAll(selector);
      if (buttons.length > 0) {
        availableButtons = buttons;
        break;
      }
    }

    console.log(`Found ${availableButtons?.length || 0} available date buttons in calendar`);

    if (availableButtons) {
      availableButtons.forEach((button) => {
        const ariaLabel = button.getAttribute('aria-label');
        if (ariaLabel && /^\d{4}-\d{2}-\d{2}$/.test(ariaLabel)) {
          availableDates.push(ariaLabel);
        }
      });
    }

    // Remove duplicates (both calendars visible) and sort
    return [...new Set(availableDates)].sort();
  }

  /**
   * Click a specific date in the Tock calendar
   */
  private async clickCalendarDate(dateString: string): Promise<boolean> {
    try {
      // Ensure calendar is open before clicking date
      await this.ensureCalendarIsOpen();

      // Get the root container (modal if present, otherwise document)
      const modal = this.getModalContainer();
      const root = modal || document;

      // Find the clickable button with this aria-label
      // Must be in-month, available, and not disabled (there may be duplicate dates in adjacent month views)
      const dateButton = root.querySelector(
        `.ConsumerCalendar-day.is-in-month.is-available[aria-label="${dateString}"]:not([disabled])`
      ) as HTMLElement;

      if (!dateButton) {
        console.error(`Could not find clickable calendar button for date: ${dateString}`);
        return false;
      }

      console.log(`Clicking calendar date: ${dateString}`);

      // Scroll the date button into view to ensure it's clickable
      dateButton.scrollIntoView({ behavior: 'instant', block: 'center' });
      await new Promise(r => setTimeout(r, 200)); // Wait for scroll

      // Click the date button
      dateButton.click();

      // Wait for page to update
      await new Promise(r => setTimeout(r, 300));

      return true;
    } catch (error) {
      console.error(`Error clicking calendar date ${dateString}:`, error);
      return false;
    }
  }

  /**
   * Public entry point for a multi-date search: given a prioritized list of desired
   * YYYY-MM-DD dates, book the first one that yields a slot.
   *
   * Desired dates are intersected with what the calendar actually offers (order of
   * `desiredDates` preserved) so we never click dead cells. For each candidate we
   * click the date, look for a matching book button, and on the first hit click it —
   * kicking off the async purchase flow when auto-purchase is enabled — and return
   * true. Returns false only if every desired-and-available date is exhausted.
   */
  public async tryMultipleDates(desiredDates: string[]): Promise<boolean> {
    console.log(`🎯 Starting multi-date search`);
    console.log(`Desired dates: ${desiredDates.join(', ')}`);

    // Get available dates from calendar
    const availableDates = await this.getAvailableDatesFromCalendar();
    console.log(`Available dates from calendar: ${availableDates.join(', ')}`);

    // Filter desired dates to only include available ones
    const datesToTry = desiredDates.filter(d => availableDates.includes(d));

    // Find dates that are desired but not available
    const unavailableDates = desiredDates.filter(d => !availableDates.includes(d));

    if (unavailableDates.length > 0) {
      console.log(`⚠️  Skipping unavailable dates: ${unavailableDates.join(', ')}`);
    }

    if (datesToTry.length === 0) {
      console.log(`❌ No available dates to try from the desired list`);
      return false;
    }

    console.log(`✅ Will try these available dates: ${datesToTry.join(', ')}`);

    // Try each available date in sequence
    for (let i = 0; i < datesToTry.length; i++) {
      const date = datesToTry[i];
      console.log(`\n🔍 Trying date ${i + 1}/${datesToTry.length}: ${date}`);

      // Always click the calendar date to trigger time slot loading
      const clicked = await this.clickCalendarDate(date);
      if (!clicked) {
        console.log(`Failed to click date ${date}, skipping`);
        continue;
      }

      // Check for book button
      const bookButton = await this.findBookButton();
      if (bookButton) {
        console.log(`✅ Book button found for date: ${date}!`);
        console.log(`Button element:`, bookButton);
        console.log(`Button tagName: ${bookButton.tagName}`);
        console.log(`Button textContent: "${bookButton.textContent}"`);

        // Check if button is actually clickable
        const rect = bookButton.getBoundingClientRect();
        console.log(`Button position - top: ${rect.top}, left: ${rect.left}, width: ${rect.width}, height: ${rect.height}`);

        const computedStyle = window.getComputedStyle(bookButton);
        console.log(`Button display: ${computedStyle.display}, visibility: ${computedStyle.visibility}, pointerEvents: ${computedStyle.pointerEvents}`);

        try {
          console.log(`Attempting to click book button with .click()...`);
          bookButton.click();
          console.log(`Book button clicked successfully`);

          // If auto-purchase is enabled, continue with purchase flow
          if (this.preferences.autoPurchaseEnabled) {
            console.log('🛒 Auto-purchase enabled, continuing to purchase flow...');
            // Don't await here - let the function return and handle purchase flow async
            setTimeout(() => this.handlePurchaseFlow(), 500);
          }
        } catch (error) {
          console.error(`Error during click:`, error);
        }

        return true;
      } else {
        console.log(`No book button found for date: ${date}`);
      }
    }

    console.log(`❌ Exhausted all available dates without finding a book button`);
    return false;
  }

  /**
   * Primary public entry point: fill and submit the Tock reservation form.
   *
   * Branches on where we start:
   *  - Already on a search-results URL → the form was pre-filled by the URL, so skip
   *    straight to `waitForAndClickBookButton()` (this is the fast path the sniper
   *    relies on — no form manipulation, minimal latency to the click).
   *  - On a restaurant page → find/fill the form (waiting for it to mount when
   *    `waitForForm`), then submit.
   * Returns true if the flow reached a successful book/submit, false on any failure
   * to find the form or (in the search-page path) the book button.
   */
  public async fill(): Promise<boolean> {
    try {
      const fillStartTime = Date.now();

      if (this.preferences.alarmFireTime) {
        console.log(`⏰ [TIMING] Form filling started (delta from alarm: ${(fillStartTime - this.preferences.alarmFireTime).toFixed(2)}ms)`);
      }

      console.log(`Starting form fill with preferences:`, this.preferences);

      // Check if we're already on the search results page
      const currentUrl = window.location.href;
      const isSearchPage = isTockSearchUrl(currentUrl);

      if (isSearchPage) {
        console.log('🎯 Already on Tock search page - skipping form fill, going straight to booking');

        if (this.autoSubmit) {
          // Wait for and click book button if available
          console.log('Looking for book button...');
          const bookButtonClicked = await this.waitForAndClickBookButton();
          if (bookButtonClicked) {
            console.log('Successfully clicked the book button!');
            return true;
          } else {
            console.log('Could not find or click the book button.');
            return false;
          }
        }

        return true;
      }

      // Not on search page - use normal form filling flow
      console.log('On restaurant page - using form filling approach');

      // If set to wait for form, keep trying to find it
      if (this.waitForForm) {
        const formElements = await this.waitForFormElements();
        if (!formElements) {
          console.error('Could not find form elements after multiple attempts');
          return false;
        }
        return await this.fillForm(formElements).catch(err => {
          console.error('Error during form filling process:', err);
          return false;
        });
      } else {
        // Try once immediately
        const formElements = this.findFormElements();
        if (!formElements.partySize || !formElements.dateButton || !formElements.timeSelect || !formElements.searchButton) {
          console.error('Could not find all form elements');
          return false;
        }
        return await this.fillForm(formElements).catch(err => {
          console.error('Error during form filling process:', err);
          return false;
        });
      }
    } catch (error) {
      console.error('Error filling form:', error);
      return false;
    }
  }

  /**
   * Find all form elements on the page
   */
  private findFormElements(): FormElements {
    const elements: FormElements = {};

    // Find party size selector
    const guestSelector = document.querySelector('[data-testid="guest-selector"]');
    if (guestSelector) {
      elements.partySize = guestSelector as HTMLElement;
    }

    // Find date button
    const dateButton = document.querySelector('[data-testid="reservation-date-button"]');
    if (dateButton) {
      elements.dateButton = dateButton as HTMLElement;
    }

    // Find time selector
    const timeSelect = document.querySelector('[data-testid="reservation-search-time"]') as HTMLSelectElement;
    if (timeSelect) {
      elements.timeSelect = timeSelect;
    }

    // Find search button
    const searchButton = document.querySelector('[data-testid="reservation-search-submit"]');
    if (searchButton) {
      elements.searchButton = searchButton as HTMLElement;
    }

    // Try to find the book button - this might not be present until after search
    const bookButton = document.querySelector('[data-testid="booking-card-button"], [data-testid="offering-book-button"], [data-testid*="book-button"]');
    if (bookButton) {
      elements.bookButton = bookButton as HTMLElement;
    }

    return elements;
  }

  /**
   * Wait for form elements to be available in the DOM
   */
  private async waitForFormElements(): Promise<FormElements | null> {
    return new Promise((resolve) => {
      const checkForElements = () => {
        this.attempts++;
        const elements = this.findFormElements();
        
        if (
          elements.partySize && 
          elements.dateButton && 
          elements.timeSelect && 
          elements.searchButton
        ) {
          resolve(elements);
        } else if (this.attempts >= this.maxAttempts) {
          resolve(null);
        } else {
          setTimeout(checkForElements, 500);
        }
      };

      checkForElements();
    });
  }

  /**
   * Fill the form with preferences
   */
  private async fillForm(elements: FormElements): Promise<boolean> {
    try {
      // Set party size
      if (elements.partySize) {
        const partySizeStart = Date.now();
        await this.setPartySize(elements.partySize, this.preferences.partySize);
        const partySizeEnd = Date.now();
        
        if (this.preferences.alarmFireTime) {
          console.log(`⏰ [TIMING] Party size set (took: ${(partySizeEnd - partySizeStart).toFixed(2)}ms, total delta: ${(partySizeEnd - this.preferences.alarmFireTime).toFixed(2)}ms)`);
        }
      }

      // Set date
      if (elements.dateButton) {
        this.dateButtonRef = elements.dateButton; // Store reference for later use
        const dateStart = Date.now();
        await this.setDate(elements.dateButton, this.preferences.date);
        const dateEnd = Date.now();
        
        if (this.preferences.alarmFireTime) {
          console.log(`⏰ [TIMING] Date set (took: ${(dateEnd - dateStart).toFixed(2)}ms, total delta: ${(dateEnd - this.preferences.alarmFireTime).toFixed(2)}ms)`);
        }
      }

      // Set time
      if (elements.timeSelect) {
        const timeStart = Date.now();
        await this.setTime(elements.timeSelect, this.preferences.time);
        const timeEnd = Date.now();
        
        if (this.preferences.alarmFireTime) {
          console.log(`⏰ [TIMING] Time set (took: ${(timeEnd - timeStart).toFixed(2)}ms, total delta: ${(timeEnd - this.preferences.alarmFireTime).toFixed(2)}ms)`);
        }
      }

      // Click search button if autoSubmit is true
      if (this.autoSubmit && elements.searchButton) {
        const searchClickTime = Date.now();
        console.log('Clicking search button...');
        
        if (this.preferences.alarmFireTime) {
          console.log(`⏰ [TIMING] ✨ SEARCH BUTTON CLICKED at: ${new Date(searchClickTime).toISOString()}`);
          console.log(`⏰ [TIMING] ⚡ TOTAL DELAY FROM ALARM TO SEARCH CLICK: ${(searchClickTime - this.preferences.alarmFireTime).toFixed(2)}ms`);
        }
        
        elements.searchButton.click();
        
        // Small delay to allow the page to start loading the search results
        console.log('Search initiated, waiting for navigation to begin...');
        await new Promise(r => setTimeout(r, 500));
        
        // Wait for and click book button if available
        console.log('Looking for book button...');
        const bookButtonClicked = await this.waitForAndClickBookButton();
        if (bookButtonClicked) {
          console.log('Successfully clicked the book button!');
        } else {
          console.log('Could not find or click the book button.');
        }
      }

      return true;
    } catch (error) {
      console.error('Error filling form:', error);
      return false;
    }
  }

  /**
   * Wait for and click the book button if available after search
   * Uses aggressive polling (100ms) for first 5 seconds to catch slots as soon as they appear
   */
  private async waitForAndClickBookButton(): Promise<boolean> {
    console.log('Waiting for book button to appear...');

    // Reset attempts counter for this operation
    this.attempts = 0;
    const startTime = Date.now();
    const aggressivePhaseMs = 5000; // First 5 seconds use aggressive polling

    return new Promise((resolve) => {
      // Use MutationObserver to detect when new elements are added to the DOM
      const observer = new MutationObserver(async (mutations) => {
        for (const mutation of mutations) {
          if (mutation.type === 'childList' && mutation.addedNodes.length > 0) {
            // Try to find the book button
            const bookButton = await this.findBookButton();
            if (bookButton) {
              observer.disconnect();
              const elapsed = Date.now() - startTime;
              console.log(`✅ Book button found via MutationObserver after ${elapsed}ms, clicking...`);
              bookButton.click();

              // If auto-purchase is enabled, continue with purchase flow
              if (this.preferences.autoPurchaseEnabled) {
                console.log('🛒 Auto-purchase enabled, continuing to purchase flow...');
                // Don't await here - let the promise resolve and handle purchase flow async
                setTimeout(() => this.handlePurchaseFlow(), 500);
              }

              resolve(true);
              return;
            }
          }
        }
      });

      // Start observing the document body for DOM changes
      observer.observe(document.body, { childList: true, subtree: true });

      // Also use polling as a fallback with aggressive timing in first 5 seconds
      const checkForBookButton = async () => {
        this.attempts++;
        const elapsed = Date.now() - startTime;

        const bookButton = await this.findBookButton();

        if (bookButton) {
          observer.disconnect();
          console.log(`✅ Book button found via polling after ${elapsed}ms (attempt ${this.attempts}), clicking...`);
          bookButton.click();

          // If auto-purchase is enabled, continue with purchase flow
          if (this.preferences.autoPurchaseEnabled) {
            console.log('🛒 Auto-purchase enabled, continuing to purchase flow...');
            // Don't await here - let the promise resolve and handle purchase flow async
            setTimeout(() => this.handlePurchaseFlow(), 500);
          }

          resolve(true);
        } else if (this.attempts >= this.maxAttempts && elapsed >= aggressivePhaseMs) {
          // Only give up after aggressive phase is complete
          observer.disconnect();
          console.log(`❌ Could not find book button after ${this.attempts} attempts and ${elapsed}ms`);
          resolve(false);
        } else {
          // Use aggressive polling (100ms) for first 5 seconds, then fall back to 500ms
          const pollInterval = elapsed < aggressivePhaseMs ? 100 : 500;
          const phase = elapsed < aggressivePhaseMs ? 'aggressive' : 'standard';
          console.log(`🔍 Book button not found yet, attempt ${this.attempts} (${phase} polling: ${pollInterval}ms, elapsed: ${elapsed}ms)`);
          setTimeout(checkForBookButton, pollInterval);
        }
      };

      // Start checking immediately, then at intervals
      checkForBookButton();

      // Set a maximum timeout of 30 seconds to prevent hanging
      setTimeout(() => {
        observer.disconnect();
        const elapsed = Date.now() - startTime;
        if (this.attempts < this.maxAttempts || elapsed < aggressivePhaseMs) {
          console.log(`⏱️ Timeout reached waiting for book button after ${elapsed}ms`);
          resolve(false);
        }
      }, 30000);
    });
  }
  
  /**
   * Convert 24-hour time format to 12-hour format
   * Example: "17:00" -> "5:00 PM"
   */
  private convertTo12HourFormat(time24: string): string {
    const [hours24, minutes] = time24.split(':').map(Number);
    const period = hours24 >= 12 ? 'PM' : 'AM';
    const hours12 = hours24 % 12 || 12;
    return `${hours12}:${minutes.toString().padStart(2, '0')} ${period}`;
  }

  /**
   * Find the "Book" button for the user's preferred time slot (or the nearest time).
   *
   * The button itself carries no time; the time label lives in a sibling/ancestor,
   * so for each `booking-card-button` we walk up to 5 ancestors looking for a
   * "5:00 PM"-style string and parse it to minutes-since-midnight. We prefer an exact
   * match to the preferred time, and otherwise fall back to the slot with the
   * smallest absolute minute difference. Before returning, the chosen button is
   * verified visible and scrolled into view so the later `.click()` lands. Returns
   * null when no timed slots are present yet (caller keeps polling).
   */
  private async findBookButton(): Promise<HTMLElement | null> {
    // Convert preference time to 12-hour format for matching
    const preferredTime = this.convertTo12HourFormat(this.preferences.time);
    console.log(`Looking for book button at preferred time: ${preferredTime}`);

    // Get the root container (modal if present, otherwise document)
    const modal = this.getModalContainer();
    const root = modal || document;

    // Find all time slot book buttons (not the generic "Book now" anchor)
    const bookButtons = Array.from(root.querySelectorAll('[data-testid="booking-card-button"]'));
    console.log(`Found ${bookButtons.length} time slot book buttons`);

    if (bookButtons.length === 0) {
      console.log('No time slot book buttons found');
      return null;
    }

    // Parse time from text content and find matching button
    const buttonWithTime: Array<{ button: HTMLElement, timeText: string, totalMinutes: number }> = [];

    for (const button of bookButtons) {
      // Walk up the DOM to find the container that has the time information
      let container = button.parentElement;
      let attempts = 0;
      let timeText = '';

      // Go up max 5 levels to find the time slot container
      while (container && attempts < 5) {
        const text = container.textContent || '';

        // Look for time pattern like "5:00 PM" or "5:30 PM"
        const timeMatch = text.match(/(\d{1,2}):(\d{2})\s*(AM|PM)/i);
        if (timeMatch) {
          timeText = `${timeMatch[1]}:${timeMatch[2]} ${timeMatch[3].toUpperCase()}`;

          // Convert to total minutes for comparison
          let hours = parseInt(timeMatch[1], 10);
          const minutes = parseInt(timeMatch[2], 10);
          const period = timeMatch[3].toUpperCase();

          if (period === 'PM' && hours < 12) {
            hours += 12;
          } else if (period === 'AM' && hours === 12) {
            hours = 0;
          }

          const totalMinutes = hours * 60 + minutes;

          buttonWithTime.push({
            button: button as HTMLElement,
            timeText,
            totalMinutes
          });

          console.log(`Found button at time: ${timeText}`);
          break;
        }

        container = container.parentElement;
        attempts++;
      }
    }

    if (buttonWithTime.length === 0) {
      console.log('No buttons with time information found');
      return null;
    }

    // Try to find exact match first
    const exactMatch = buttonWithTime.find(item => item.timeText === preferredTime);
    if (exactMatch) {
      console.log(`Found exact time match: ${exactMatch.timeText}`);

      // Ensure element is visible and clickable
      const style = window.getComputedStyle(exactMatch.button);
      if (style.display === 'none' || style.visibility === 'hidden') {
        console.log('Button found but is not visible');
        return null;
      }

      // Scroll into view if needed
      const rect = exactMatch.button.getBoundingClientRect();
      const isInViewport = rect.top >= 0 &&
                          rect.left >= 0 &&
                          rect.bottom <= window.innerHeight &&
                          rect.right <= window.innerWidth;

      if (!isInViewport) {
        console.log('Button found but is outside viewport, scrolling into view...');
        exactMatch.button.scrollIntoView({ behavior: 'instant', block: 'center' });
        await new Promise(resolve => setTimeout(resolve, 300));
      }

      return exactMatch.button;
    }

    // No exact match, find closest time
    console.log(`No exact match for ${preferredTime}, finding closest time...`);

    // Convert preferred time to total minutes
    const preferredTimeMatch = preferredTime.match(/(\d{1,2}):(\d{2})\s*(AM|PM)/i);
    if (!preferredTimeMatch) {
      console.log('Could not parse preferred time');
      return null;
    }

    let preferredHours = parseInt(preferredTimeMatch[1], 10);
    const preferredMinutes = parseInt(preferredTimeMatch[2], 10);
    const preferredPeriod = preferredTimeMatch[3].toUpperCase();

    if (preferredPeriod === 'PM' && preferredHours < 12) {
      preferredHours += 12;
    } else if (preferredPeriod === 'AM' && preferredHours === 12) {
      preferredHours = 0;
    }

    const preferredTotalMinutes = preferredHours * 60 + preferredMinutes;

    // Find closest time
    let closestItem = buttonWithTime[0];
    let closestDiff = Math.abs(preferredTotalMinutes - closestItem.totalMinutes);

    for (const item of buttonWithTime) {
      const diff = Math.abs(preferredTotalMinutes - item.totalMinutes);
      if (diff < closestDiff) {
        closestDiff = diff;
        closestItem = item;
      }
    }

    console.log(`Found closest time match: ${closestItem.timeText} (preferred: ${preferredTime})`);

    // Ensure element is visible and clickable
    const style = window.getComputedStyle(closestItem.button);
    if (style.display === 'none' || style.visibility === 'hidden') {
      console.log('Closest button found but is not visible');
      return null;
    }

    // Scroll into view if needed
    const rect = closestItem.button.getBoundingClientRect();
    const isInViewport = rect.top >= 0 &&
                        rect.left >= 0 &&
                        rect.bottom <= window.innerHeight &&
                        rect.right <= window.innerWidth;

    if (!isInViewport) {
      console.log('Closest button found but is outside viewport, scrolling into view...');
      closestItem.button.scrollIntoView({ behavior: 'instant', block: 'center' });
      await new Promise(resolve => setTimeout(resolve, 300));
    }

    return closestItem.button;
  }

  /**
   * Set the party size by simulating plus/minus button clicks
   */
  private async setPartySize(partySizeElement: HTMLElement, targetSize: number): Promise<void> {
    const textElement = partySizeElement.querySelector('[data-testid="guest-selector-text"]');
    if (!textElement) return;

    // Extract the current party size
    const currentSizeMatch = textElement.textContent?.match(/(\d+)\s+guests?/);
    const currentSize = currentSizeMatch ? parseInt(currentSizeMatch[1], 10) : 0;

    if (currentSize === targetSize) return;

    // Find plus/minus buttons
    const plusButton = partySizeElement.querySelector('[data-testid="guest-selector_plus"]') as HTMLElement;
    const minusButton = partySizeElement.querySelector('[data-testid="guest-selector_minus"]') as HTMLElement;

    if (!plusButton || !minusButton) return;

    // Click buttons to adjust party size
    if (currentSize < targetSize) {
      // Need to increase
      const clicksNeeded = targetSize - currentSize;
      for (let i = 0; i < clicksNeeded; i++) {
        plusButton.click();
        await new Promise(r => setTimeout(r, 100));
      }
    } else {
      // Need to decrease
      const clicksNeeded = currentSize - targetSize;
      for (let i = 0; i < clicksNeeded; i++) {
        minusButton.click();
        await new Promise(r => setTimeout(r, 100));
      }
    }
  }

  /**
   * Set the date by opening the calendar and clicking the target day.
   *
   * Two things worth knowing:
   *  - ISO `YYYY-MM-DD` input is parsed field-by-field into a *local* Date at noon,
   *    not via `new Date(str)` (which parses ISO as UTC and can shift the day back
   *    one for negative-offset timezones). Noon keeps the day stable under DST math.
   *  - Selection is best-effort with escalating retries: try `findAndClickDate`,
   *    retry after a delay, then close/reopen the picker and fall back to Tock-
   *    specific handling and finally a raw `<input type=date>` if one exists. The
   *    redundancy exists because Tock's calendar occasionally swallows the first click.
   */
  private async setDate(dateButton: HTMLElement, targetDate: string): Promise<void> {
    // Parse the target date string, ensuring it's in the correct format
    let date: Date;
    let day: number;
    let month: number;
    let year: number;
    
    console.log(`Original target date string: ${targetDate}`);
    
    // Check if the date string is already in ISO format (YYYY-MM-DD)
    if (/^\d{4}-\d{2}-\d{2}$/.test(targetDate)) {
      // Parse the date in local timezone instead of UTC
      const parts = targetDate.split('-').map(Number);
      year = parts[0];
      month = parts[1] - 1; // JS months are 0-indexed
      day = parts[2];
      // Create a new date ensuring it uses the exact values provided
      date = new Date(year, month, day, 12, 0, 0); // noon to avoid timezone issues
      console.log(`Parsed ISO date: ${targetDate} -> ${date.toDateString()}`);
      console.log(`Parsed values - Day: ${day}, Month: ${month + 1}, Year: ${year}`);
    } else {
      // Try standard parsing for other formats
      date = new Date(targetDate);
      day = date.getDate();
      month = date.getMonth();
      year = date.getFullYear();
    }
    
    // Double-check that we have the correct date values
    console.log(`Final date values - Day: ${day}, Month: ${month + 1}, Year: ${year}`);
    
    const formattedDate = date.toLocaleDateString('en-US', {
      day: 'numeric',
      month: 'short', 
      year: 'numeric'
    });
    
    console.log(`Attempting to select date: ${formattedDate} (day: ${day}, month: ${month + 1}, year: ${year})`);

    // Click date button to open calendar
    dateButton.click();
    await new Promise(r => setTimeout(r, 300)); // Increased wait time

    // Try multiple strategies to find and click the correct date
    let success = await this.findAndClickDate(date, formattedDate);
    
    // If first attempt failed, try once more after a short delay
    if (!success) {
      console.log('First date selection attempt failed, trying again...');
      await new Promise(r => setTimeout(r, 500));
      success = await this.findAndClickDate(date, formattedDate);
      
      // If still failed, try closing and reopening the date picker
      if (!success) {
        console.log('Second attempt failed, trying to reset the date picker...');
        // Try to close the date picker
        const closeButtons = document.querySelectorAll('[aria-label="Close"], .close-button, button.close');
        if (closeButtons.length > 0) {
          (closeButtons[0] as HTMLElement).click();
          await new Promise(r => setTimeout(r, 300));
        } else {
          // Or click outside to close it
          document.body.click();
          await new Promise(r => setTimeout(r, 300));
        }
        
        // Reopen and try again
        dateButton.click();
        await new Promise(r => setTimeout(r, 300));
        
        // Try a more direct approach
        console.log(`Last attempt, trying direct approach for day ${day}, month ${month + 1}, year ${year}`);
        
        // Try a more direct approach - look for the target day in the current month
        const calendar = document.querySelector('[id^="date_selector"], [class*="calendar"], [class*="datepicker"]') as HTMLElement;
        if (calendar) {
          // Specific handling for Tock calendar
          await this.handleTockCalendar(calendar, day, month, year);
        }
        
        // Last resort - try to use direct input if available
        const dateInput = document.querySelector('input[type="date"], input[placeholder*="date"], input[aria-label*="date"]') as HTMLInputElement;
        if (dateInput) {
          console.log('Using date input as fallback');
          const dateString = `${year}-${(month + 1).toString().padStart(2, '0')}-${day.toString().padStart(2, '0')}`;
          dateInput.value = dateString;
          dateInput.dispatchEvent(new Event('change', { bubbles: true }));
          dateInput.dispatchEvent(new Event('input', { bubbles: true }));
        }
      }
    }
  }

  /**
   * Attempts multiple strategies to find and click the date in the calendar
   */
  private async findAndClickDate(date: Date, formattedDate: string): Promise<boolean> {
    const day = date.getDate();
    const month = date.getMonth();
    const year = date.getFullYear();
    
    // Strategy 1: Look for calendar container with ID starting with 'date_selector'
    let calendar: HTMLElement | null = null;
    
    // Find elements with IDs starting with 'date_selector'
    const dateSelectors = Array.from(document.querySelectorAll('[id^="date_selector"]'));
    if (dateSelectors.length > 0) {
      calendar = dateSelectors[0] as HTMLElement;
      console.log(`Found calendar with ID: ${calendar.id}`);
    }
    
    // Strategy 2: Look for any date picker container
    if (!calendar) {
      const possibleCalendars = document.querySelectorAll('[class*="calendar"], [class*="datepicker"], [aria-label*="calendar"], [role="dialog"]');
      if (possibleCalendars.length > 0) {
        calendar = possibleCalendars[0] as HTMLElement;
        console.log('Found calendar using class name strategy');
      }
    }
    
    // Strategy 3: Look for the calendar by its date attributes
    if (!calendar) {
      const calendarContainers = Array.from(document.querySelectorAll('div')).filter(el => {
        return el.querySelectorAll('[aria-label*="day"], [data-date], [data-day]').length > 10;
      });
      
      if (calendarContainers.length > 0) {
        calendar = calendarContainers[0] as HTMLElement;
        console.log('Found calendar using DOM structure analysis');
      }
    }

    if (calendar) {
      console.log('Calendar found, now checking if we need to navigate to the correct month');
      
      // Navigate to the correct month before trying to select the date
      await this.navigateToCorrectMonth(calendar, month, year);
      
      // Special handling for Tock-specific calendar
      console.log('Attempting direct Tock calendar strategy...');
      const tockCalendarSuccess = await this.handleTockCalendar(calendar, day, month, year);
      if (tockCalendarSuccess) {
        return true;
      }
      
      // After navigation, try to find and click the date
      if (await this.tryClickDate(calendar, day, formattedDate, date)) {
        return true;
      }
    }
    
    console.log('Could not find date element to click, trying fallback method');
    
    // Fallback: Try to set the date directly if there's an input field
    const dateInput = document.querySelector('input[type="date"], input[placeholder*="date"], input[aria-label*="date"]') as HTMLInputElement;
    if (dateInput) {
      console.log('Found date input, setting value directly');
      const dateString = date.toISOString().split('T')[0]; // YYYY-MM-DD format
      dateInput.value = dateString;
      dateInput.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    }
    
    // Last fallback: Try to close the calendar if we couldn't select anything
    const closeButtons = document.querySelectorAll('[aria-label="Close"], .close-button, button.close');
    if (closeButtons.length > 0) {
      (closeButtons[0] as HTMLElement).click();
    }
    
    return false;
  }

  /**
   * Verify if the selected date is correct
   */
  private verifyDateSelection(dateText: string, day: number, month: number): boolean {
    // Check if the text contains the day number
    if (!dateText.includes(day.toString())) {
      return false;
    }
    
    // Check for month names
    const monthNames = ['January', 'February', 'March', 'April', 'May', 'June', 
                       'July', 'August', 'September', 'October', 'November', 'December'];
    const shortMonthNames = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 
                           'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    
    // Special case: If the dateText contains something like "Date10 Jun 2025"
    // which is a specific format seen in Tock
    const dateMatch = dateText.match(/Date(\d+)\s+([A-Za-z]+)\s+(\d{4})/);
    if (dateMatch) {
      const extractedDay = parseInt(dateMatch[1], 10);
      const extractedMonth = dateMatch[2];
      
      if (extractedDay === day) {
        // Check if the month matches
        const monthIndex = [...monthNames, ...shortMonthNames].findIndex(
          name => name.toLowerCase() === extractedMonth.toLowerCase()
        ) % 12;
        
        return monthIndex === month;
      }
    }
    
    // Regular check: Look for month name in the date text
    for (let i = 0; i < monthNames.length; i++) {
      if (dateText.includes(monthNames[i]) || dateText.includes(shortMonthNames[i])) {
        return i === month;
      }
    }
    
    // If we can't definitively verify, but it has the day, let's accept it
    return true;
  }

  /**
   * Try to find and click the target date element in the calendar
   */
  private async tryClickDate(calendar: HTMLElement, day: number, formattedDate: string, date: Date): Promise<boolean> {
    console.log(`Looking for date element: day ${day}, formatted date ${formattedDate}`);
    
    // Try multiple strategies to find the date element
    let dateElement: HTMLElement | null = null;
    
    // Strategy 1: Find by aria-label containing the formatted date
    const datesByAriaLabel = Array.from(document.querySelectorAll(`[aria-label*="${formattedDate}"], [aria-label*="${date.getDate()}"]`));
    if (datesByAriaLabel.length > 0) {
      console.log('Found potential date elements by aria-label:', datesByAriaLabel.length);
      
      // Filter date elements to ensure we get the right day
      for (const el of datesByAriaLabel) {
        // Verify this is actually the correct date by checking the text content
        const dayText = el.textContent?.trim();
        if (dayText === day.toString()) {
          dateElement = el as HTMLElement;
          console.log(`Found date element by aria-label with matching day text: ${dayText}`);
          break;
        }
      }
    }
    
    // Strategy 2: Find by data-date attribute
    if (!dateElement) {
      const targetDateStr = `${date.getFullYear()}-${(date.getMonth() + 1).toString().padStart(2, '0')}-${day.toString().padStart(2, '0')}`;
      const datesByDataAttr = document.querySelectorAll(`[data-date="${targetDateStr}"]`);
      if (datesByDataAttr.length > 0) {
        dateElement = datesByDataAttr[0] as HTMLElement;
        console.log(`Found date element by data-date attribute: ${targetDateStr}`);
      }
    }
    
    // Strategy 3: Find by text content containing the day
    if (!dateElement) {
      // Use calendar as the root if available, otherwise use document
      const root = calendar || document;
      
      // Find all elements that could be day cells within the calendar
      const dayCells = Array.from(root.querySelectorAll('td, div, button')).filter(el => {
        const text = el.textContent?.trim();
        return text === day.toString() && el.getAttribute('role') !== 'row';
      });
      
      console.log(`Found ${dayCells.length} elements with day text ${day}`);
      
      // Find the one that's visible and is current month (not disabled)
      for (const cell of dayCells) {
        // Check if the cell is visible (not hidden by CSS)
        const style = window.getComputedStyle(cell);
        const isVisible = style.display !== 'none' && style.visibility !== 'hidden';
        const isClickable = !cell.classList.contains('disabled') && 
                            !cell.hasAttribute('disabled') && 
                            !cell.classList.contains('outside-month') &&
                            !cell.classList.contains('other-month');
        
        if (isVisible && isClickable) {
          // Additional verification: check if parent elements have any indication of current month
          let isCurrentMonth = true;
          let parent = cell.parentElement;
          
          // Check up to 3 levels of parent elements for month indicators
          for (let i = 0; i < 3 && parent; i++) {
            if (parent.classList.contains('outside-month') || 
                parent.classList.contains('other-month') || 
                parent.classList.contains('disabled') ||
                parent.getAttribute('aria-disabled') === 'true') {
              isCurrentMonth = false;
              break;
            }
            parent = parent.parentElement;
          }
          
          if (isCurrentMonth) {
            dateElement = cell as HTMLElement;
            console.log(`Found date element by day text content: ${dateElement.textContent}`);
            break;
          }
        }
      }
    }
    
    // Verify the date before clicking
    if (dateElement) {
      // Double-check the selected date matches our target
      const elementText = dateElement.textContent?.trim();
      const expectedDay = day.toString();
      
      console.log(`Found date element with text: ${elementText}, expected day: ${expectedDay}`);
      
      if (elementText !== expectedDay) {
        console.log(`Text mismatch! Looking for another matching element`);
        
        // Try again with a more specific search
        const betterMatches = Array.from(calendar.querySelectorAll('td, div, button'))
          .filter(el => {
            const text = el.textContent?.trim();
            const style = window.getComputedStyle(el);
            return text === expectedDay && 
                   style.display !== 'none' && 
                   style.visibility !== 'hidden';
          });
        
        console.log(`Found ${betterMatches.length} better matches`);
        
        if (betterMatches.length > 0) {
          dateElement = betterMatches[0] as HTMLElement;
        }
      }
      
      console.log(`Clicking date element for day ${day}`);
      dateElement.click();
      
      // Wait for the calendar to close
      await new Promise(r => setTimeout(r, 250));
      
      // Verify selection was successful by checking if the date string contains the day and month
      const currentDateText = this.dateButtonRef?.textContent?.trim() || '';
      console.log(`Date button text after selection: ${currentDateText}`);
      
      // Use our flexible verification method
      const isVerified = this.verifyDateSelection(currentDateText, day, date.getMonth());
      
      if (!isVerified) {
        console.log(`Selected date doesn't match target! Expected month: ${date.getMonth() + 1}, day: ${day}`);
        return false;
      }
      
      return true;
    }
    
    return false;
  }

  /**
   * Tock-specific date clicker: four strategies tried in descending precision.
   *
   *   1. Exact `button[aria-label="YYYY-MM-DD"]` (Tock's canonical day cell).
   *   2. `.ConsumerCalendar-day` cells filtered to in-month + available.
   *   3. `[data-testid="consumer-calendar-day"]` cells with matching day text.
   *   4. Brute force: any visible element on the page whose text equals the day.
   *
   * Every strategy clicks then *verifies* by re-reading `dateButtonRef`'s label for
   * the day number before declaring success — a click that doesn't move the selection
   * (disabled/out-of-month cell) is treated as a miss so the next strategy runs.
   */
  private async handleTockCalendar(calendar: HTMLElement, day: number, month: number, year: number): Promise<boolean> {
    try {
      console.log(`Tock calendar handler for day ${day}, month ${month + 1}, year ${year}`);
      
      // Strategy 1: Look specifically for Tock's "ConsumerCalendar-day" elements with aria-label pattern
      const dateSelector = `button[aria-label="${year}-${(month + 1).toString().padStart(2, '0')}-${day.toString().padStart(2, '0')}"]`;
      const exactDateElement = document.querySelector(dateSelector);
      
      if (exactDateElement) {
        console.log(`Found exact date element using aria-label selector: ${dateSelector}`);
        const isDisabled = 
          exactDateElement.hasAttribute('disabled') || 
          exactDateElement.getAttribute('aria-disabled') === 'true' ||
          exactDateElement.classList.contains('is-disabled');
        
        if (!isDisabled) {
          console.log(`Clicking exact date element for day ${day}`);
          (exactDateElement as HTMLElement).click();
          await new Promise(r => setTimeout(r, 300));
          
          // Verify selection worked
          const dateButtonText = this.dateButtonRef?.textContent || '';
          console.log(`Date button text after selection: ${dateButtonText}`);
          
          if (dateButtonText.includes(day.toString())) {
            console.log(`Selection verified for day ${day}`);
            return true;
          }
        } else {
          console.log(`Found date element but it's disabled`);
        }
      }
      
      // Strategy 2: Find by ConsumerCalendar-day class and is-in-month and is-available classes
      const dayElements = Array.from(document.querySelectorAll('.ConsumerCalendar-day.is-in-month:not(.is-disabled)'));
      console.log(`Found ${dayElements.length} potential day elements in current month`);
      
      for (const element of dayElements) {
        const dayText = element.textContent?.trim();
        if (dayText === day.toString()) {
          console.log(`Found day ${day} in ConsumerCalendar-day element`);
          
          // Check if it's in the right month (is-in-month and not is-out-of-month)
          const isCurrentMonth = element.classList.contains('is-in-month') && 
                               !element.classList.contains('is-out-of-month');
          
          // Check if it's available
          const isAvailable = element.classList.contains('is-available') && 
                            !element.hasAttribute('disabled') && 
                            element.getAttribute('aria-disabled') !== 'true';
          
          if (isCurrentMonth && isAvailable) {
            console.log(`Clicking day element for day ${day}`);
            (element as HTMLElement).click();
            await new Promise(r => setTimeout(r, 300));
            
            // Verify selection
            const dateButtonText = this.dateButtonRef?.textContent || '';
            console.log(`Date button text after selection: ${dateButtonText}`);
            
            if (dateButtonText.includes(day.toString())) {
              console.log(`Successfully selected day ${day}`);
              return true;
            }
          }
        }
      }
      
      // Strategy 3: Brute force with specific element targeting
      console.log('Trying data-testid approach for Tock calendar');
      const consumerCalendarDays = Array.from(document.querySelectorAll('[data-testid="consumer-calendar-day"]'))
        .filter(el => {
          const text = el.textContent?.trim();
          return text === day.toString() && 
                 !el.classList.contains('is-disabled') && 
                 !el.hasAttribute('disabled') &&
                 el.classList.contains('is-in-month') &&
                 !el.classList.contains('is-out-of-month');
        });
      
      console.log(`Found ${consumerCalendarDays.length} consumer calendar days with text "${day}"`);
      
      for (const element of consumerCalendarDays) {
        console.log(`Clicking consumer calendar day element for day ${day}`);
        (element as HTMLElement).click();
        await new Promise(r => setTimeout(r, 300));
        
        // Verify selection
        const dateButtonText = this.dateButtonRef?.textContent || '';
        console.log(`Date button text after selection: ${dateButtonText}`);
        
        if (dateButtonText.includes(day.toString())) {
          console.log(`Successfully selected day ${day} with consumer calendar day approach`);
          return true;
        }
      }
      
      // Strategy 4: Brute force all day elements as last resort
      console.log('Trying brute force approach for all day elements');
      const allDayElements = Array.from(document.querySelectorAll('button, td, [role="gridcell"]'))
        .filter(el => {
          const text = el.textContent?.trim();
          return text === day.toString();
        });
      
      console.log(`Found ${allDayElements.length} elements with text "${day}" across the entire page`);
      
      for (const element of allDayElements) {
        // Check if the element is visible and clickable
        const style = window.getComputedStyle(element);
        if (style.display !== 'none' && style.visibility !== 'hidden') {
          console.log(`Trying visible element with day ${day}`);
          (element as HTMLElement).click();
          await new Promise(r => setTimeout(r, 300));
          
          // Check the date button text
          const dateText = this.dateButtonRef?.textContent || '';
          console.log(`Date button text after click: ${dateText}`);
          
          if (dateText.includes(day.toString())) {
            console.log(`Successfully selected day ${day} with brute force approach`);
            return true;
          }
        }
      }
      
      return false;
    } catch (error) {
      console.error('Error in Tock calendar handling:', error);
      return false;
    }
  }

  /**
   * Page the calendar to `targetMonth`/`targetYear` by clicking prev/next.
   *
   * Reads the currently displayed month/year from the header (trying several header
   * shapes and both long and short month names), computes the signed month delta, and
   * clicks the corresponding arrow that many times. Header text and nav buttons are
   * located heuristically (aria-label/title/class, then geometric left-vs-right
   * position as a last resort) because the calendar markup isn't stable. After the
   * final click it re-reads the header and, if still short of target, nudges up to 3
   * more months to absorb off-by-one drift. `targetMonth` is 0-indexed (JS months).
   */
  private async navigateToCorrectMonth(calendar: HTMLElement, targetMonth: number, targetYear: number): Promise<boolean> {
    // Get current displayed month/year from calendar header
    const getDisplayedMonthYear = (): { month: number, year: number } | null => {
      // Try multiple ways to find the month/year header
      const possibleMonthHeaders = [
        ...Array.from(calendar.querySelectorAll('[class*="month-header"], [class*="calendar-header"], [class*="header"]')),
        ...Array.from(calendar.querySelectorAll('h2, h3, h4, .header, .title')),
        ...Array.from(calendar.querySelectorAll('[aria-live="polite"]'))
      ];
      
      for (const header of possibleMonthHeaders) {
        const text = header.textContent || '';
        console.log(`Found possible month header: ${text}`);
        
        // Check for month names
        const monthNames = ['January', 'February', 'March', 'April', 'May', 'June', 
                           'July', 'August', 'September', 'October', 'November', 'December'];
        const shortMonthNames = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 
                                'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
        
        let foundMonth = -1;
        let foundYear = -1;
        
        // Try to match long month names
        for (let i = 0; i < monthNames.length; i++) {
          if (text.includes(monthNames[i])) {
            foundMonth = i;
            break;
          }
        }
        
        // If no match, try short month names
        if (foundMonth === -1) {
          for (let i = 0; i < shortMonthNames.length; i++) {
            if (text.includes(shortMonthNames[i])) {
              foundMonth = i;
              break;
            }
          }
        }
        
        // Try to extract year (4 digits)
        const yearMatch = text.match(/\b(20\d{2})\b/);
        if (yearMatch) {
          foundYear = parseInt(yearMatch[1], 10);
        }
        
        if (foundMonth !== -1 && foundYear !== -1) {
          console.log(`Found displayed month/year: ${foundMonth}/${foundYear}`);
          return { month: foundMonth, year: foundYear };
        }
      }
      
      return null;
    };
    
    // Find navigation buttons (previous/next month)
    const findNavButtons = (): { prev: HTMLElement | null, next: HTMLElement | null } => {
      let prevButton: HTMLElement | null = null;
      let nextButton: HTMLElement | null = null;
      
      // Try to find by aria-label or title
      const buttons = calendar.querySelectorAll('button, [role="button"]');
      for (const button of Array.from(buttons)) {
        const ariaLabel = button.getAttribute('aria-label') || '';
        const title = button.getAttribute('title') || '';
        const className = button.className || '';
        const text = button.textContent || '';
        
        const isPrev = 
          ariaLabel.includes('previous') || ariaLabel.includes('prev') ||
          title.includes('previous') || title.includes('prev') ||
          className.includes('prev') || 
          text.includes('←') || text.includes('<');
        
        const isNext = 
          ariaLabel.includes('next') ||
          title.includes('next') ||
          className.includes('next') ||
          text.includes('→') || text.includes('>');
        
        if (isPrev) {
          prevButton = button as HTMLElement;
        } else if (isNext) {
          nextButton = button as HTMLElement;
        }
        
        if (prevButton && nextButton) break;
      }
      
      // If we still don't have buttons, try by element types that might be navigation buttons
      if (!prevButton || !nextButton) {
        // Look for SVG icons or spans that might be navigation buttons
        const possibleNavs = calendar.querySelectorAll('svg, span.icon, i.icon, .arrow');
        
        for (const nav of Array.from(possibleNavs)) {
          const parent = nav.parentElement as HTMLElement;
          if (!parent) continue;
          
          const rect = parent.getBoundingClientRect();
          const calendarRect = calendar.getBoundingClientRect();
          
          // If element is on the left side of the calendar, it might be prev button
          if (rect.left < calendarRect.left + calendarRect.width * 0.3 && !prevButton) {
            prevButton = parent;
          }
          // If element is on the right side of the calendar, it might be next button
          else if (rect.right > calendarRect.right - calendarRect.width * 0.3 && !nextButton) {
            nextButton = parent;
          }
        }
      }
      
      console.log(`Found navigation buttons: prev=${!!prevButton}, next=${!!nextButton}`);
      return { prev: prevButton, next: nextButton };
    };
    
    // Get initial displayed month/year
    const initialMonthYear = getDisplayedMonthYear();
    if (!initialMonthYear) {
      console.log('Could not determine current displayed month/year');
      return false;
    }
    
    let currentMonth = initialMonthYear.month;
    let currentYear = initialMonthYear.year;
    
    // Calculate how many months to navigate
    const monthsToNavigate = 
      (targetYear - currentYear) * 12 + (targetMonth - currentMonth);
    
    console.log(`Current Month/Year: ${currentMonth + 1}/${currentYear}, Target: ${targetMonth + 1}/${targetYear}`);
    
    if (monthsToNavigate === 0) {
      console.log('Already on the correct month');
      return true;
    }
    
    console.log(`Need to navigate ${monthsToNavigate} months (${monthsToNavigate > 0 ? 'forward' : 'backward'})`);
    
    // Find navigation buttons
    const { prev, next } = findNavButtons();
    
    if (monthsToNavigate > 0 && next) {
      // Navigate forward
      for (let i = 0; i < monthsToNavigate; i++) {
        console.log(`Clicking next month button (${i+1}/${monthsToNavigate})`);
        next.click();
        await new Promise(r => setTimeout(r, 300));
        
        // Verify navigation was successful
        if (i === monthsToNavigate - 1) {
          const finalMonth = getDisplayedMonthYear();
          if (finalMonth) {
            console.log(`After navigation, month is now: ${finalMonth.month + 1}/${finalMonth.year}`);
            if (finalMonth.month !== targetMonth || finalMonth.year !== targetYear) {
              console.log(`Navigation didn't reach target month! Current: ${finalMonth.month + 1}/${finalMonth.year}, Target: ${targetMonth + 1}/${targetYear}`);
              
              // Try to navigate directly if we're not on the right month
              const remainingMonths = (targetYear - finalMonth.year) * 12 + (targetMonth - finalMonth.month);
              if (remainingMonths > 0 && remainingMonths <= 3) {
                console.log(`Trying to navigate ${remainingMonths} more months`);
                for (let j = 0; j < remainingMonths; j++) {
                  next.click();
                  await new Promise(r => setTimeout(r, 300));
                }
              }
            }
          }
        }
      }
      return true;
    } else if (monthsToNavigate < 0 && prev) {
      // Navigate backward
      for (let i = 0; i < Math.abs(monthsToNavigate); i++) {
        console.log(`Clicking previous month button (${i+1}/${Math.abs(monthsToNavigate)})`);
        prev.click();
        await new Promise(r => setTimeout(r, 300));
        
        // Verify navigation was successful
        if (i === Math.abs(monthsToNavigate) - 1) {
          const finalMonth = getDisplayedMonthYear();
          if (finalMonth) {
            console.log(`After navigation, month is now: ${finalMonth.month + 1}/${finalMonth.year}`);
            if (finalMonth.month !== targetMonth || finalMonth.year !== targetYear) {
              console.log(`Navigation didn't reach target month! Current: ${finalMonth.month + 1}/${finalMonth.year}, Target: ${targetMonth + 1}/${targetYear}`);
              
              // Try to navigate directly if we're not on the right month
              const remainingMonths = (finalMonth.year - targetYear) * 12 + (finalMonth.month - targetMonth);
              if (remainingMonths > 0 && remainingMonths <= 3) {
                console.log(`Trying to navigate ${remainingMonths} more months backward`);
                for (let j = 0; j < remainingMonths; j++) {
                  prev.click();
                  await new Promise(r => setTimeout(r, 300));
                }
              }
            }
          }
        }
      }
      return true;
    }
    
    console.log('Could not navigate to correct month');
    return false;
  }

  /**
   * Select the target time in the `<select>` dropdown, dispatching a `change` event
   * so React notices the programmatic selection.
   *
   * The preference is 24-hour ("17:00") but options render 12-hour ("5:00 PM"), so we
   * format and look for an exact option-text match first; failing that we parse every
   * option into minutes-since-midnight and pick the closest, matching the same
   * nearest-time tolerance `findBookButton` uses for slots.
   */
  private async setTime(timeSelect: HTMLSelectElement, targetTime: string): Promise<void> {
    // Format the time to match what's in the dropdown
    let formattedTime = targetTime;
    
    // Convert 24-hour time to 12-hour if needed
    if (targetTime.match(/^\d{1,2}:\d{2}$/)) {
      const [hours, minutes] = targetTime.split(':').map(Number);
      const period = hours >= 12 ? 'PM' : 'AM';
      const hours12 = hours % 12 || 12;
      formattedTime = `${hours12}:${minutes.toString().padStart(2, '0')} ${period}`;
    }

    // Try to find exact match first
    for (let i = 0; i < timeSelect.options.length; i++) {
      if (timeSelect.options[i].text === formattedTime) {
        timeSelect.selectedIndex = i;
        timeSelect.dispatchEvent(new Event('change', { bubbles: true }));
        return;
      }
    }

    // If no exact match, try to find closest match
    // First, normalize the target time to 24-hour format
    const targetTimeParts = targetTime.split(':');
    const targetHour = parseInt(targetTimeParts[0], 10);
    const targetMinute = parseInt(targetTimeParts[1], 10);
    const targetTotalMinutes = targetHour * 60 + targetMinute;

    let closestIndex = 0;
    let closestDiff = Number.MAX_SAFE_INTEGER;

    for (let i = 0; i < timeSelect.options.length; i++) {
      const optionTime = timeSelect.options[i].text;
      const optionMatch = optionTime.match(/(\d{1,2}):(\d{2})(?:\s+([AP]M))?/);
      
      if (optionMatch) {
        let optionHour = parseInt(optionMatch[1], 10);
        const optionMinute = parseInt(optionMatch[2], 10);
        const optionPeriod = optionMatch[3];
        
        // Convert to 24-hour if in 12-hour format
        if (optionPeriod) {
          if (optionPeriod === 'PM' && optionHour < 12) {
            optionHour += 12;
          } else if (optionPeriod === 'AM' && optionHour === 12) {
            optionHour = 0;
          }
        }
        
        const optionTotalMinutes = optionHour * 60 + optionMinute;
        const diff = Math.abs(targetTotalMinutes - optionTotalMinutes);
        
        if (diff < closestDiff) {
          closestDiff = diff;
          closestIndex = i;
        }
      }
    }

    // Set the closest match
    timeSelect.selectedIndex = closestIndex;
    timeSelect.dispatchEvent(new Event('change', { bubbles: true }));
  }

  /**
   * Public: drive from the just-clicked book button to a completed purchase.
   *
   * Tock may interpose zero or more add-ons/supplement interstitials before the
   * payment page, in two shapes (inline "confirm" button vs a "View Order" modal), so
   * this is a poll loop (up to 30s): whenever an add-ons page appears we dismiss it
   * and `continue` looping; when the purchase button appears we hand off to
   * `handlePurchaseConfirmation()`. Returns false on timeout or if an interstitial
   * handler fails.
   */
  public async handlePurchaseFlow(): Promise<boolean> {
    console.log('🛒 Starting auto-purchase flow...');

    // Wait for the page to update after clicking book button
    await new Promise(r => setTimeout(r, 1000));

    // Poll for either add-ons page or purchase confirmation page
    const maxWaitTime = 30000; // 30 seconds max wait
    const startTime = Date.now();

    while (Date.now() - startTime < maxWaitTime) {
      // Check for add-ons page (supplement group confirm button)
      const addOnsButton = document.querySelector('[data-testid="supplement-group-confirm-button"]');
      if (addOnsButton) {
        console.log('📦 Add-ons page detected, skipping...');
        const addOnsResult = await this.handleAddOnsPage();
        if (!addOnsResult) {
          console.log('❌ Failed to handle add-ons page');
          return false;
        }
        // Continue to wait for purchase confirmation
        await new Promise(r => setTimeout(r, 1000));
        continue;
      }

      // Check for alternate add-ons page with "View Order" button
      const viewOrderButton = document.querySelector('[data-testid="supplement-page-view-order"]');
      if (viewOrderButton) {
        console.log('📦 Alternate add-ons page detected (View Order)...');
        const altAddOnsResult = await this.handleAlternateAddOnsPage();
        if (!altAddOnsResult) {
          console.log('❌ Failed to handle alternate add-ons page');
          return false;
        }
        // Continue to wait for purchase confirmation
        await new Promise(r => setTimeout(r, 1000));
        continue;
      }

      // Check for purchase confirmation page (purchase button)
      const purchaseButton = document.querySelector('[data-testid="purchase-button"]');
      if (purchaseButton) {
        console.log('💳 Purchase confirmation page detected');
        return await this.handlePurchaseConfirmation();
      }

      // Wait before checking again
      await new Promise(r => setTimeout(r, 300));
    }

    console.log('⏱️ Timeout waiting for purchase page');
    return false;
  }

  /**
   * Handle the add-ons page by clicking the skip/next button
   */
  private async handleAddOnsPage(): Promise<boolean> {
    try {
      const skipButton = document.querySelector('[data-testid="supplement-group-confirm-button"]') as HTMLElement;

      if (!skipButton) {
        console.log('Could not find add-ons skip button');
        return false;
      }

      console.log('Clicking "Next: Review and Purchase" button...');
      skipButton.click();

      // Wait for navigation
      await new Promise(r => setTimeout(r, 1500));

      return true;
    } catch (error) {
      console.error('Error handling add-ons page:', error);
      return false;
    }
  }

  /**
   * Handle alternate add-ons page with "View Order" button that opens a modal
   */
  private async handleAlternateAddOnsPage(): Promise<boolean> {
    try {
      // Click "View Order" button
      const viewOrderBtn = document.querySelector('[data-testid="supplement-page-view-order"]') as HTMLElement;
      if (!viewOrderBtn) {
        console.log('Could not find "View Order" button');
        return false;
      }

      console.log('Clicking "View Order" button...');
      viewOrderBtn.click();

      // Wait for modal to appear
      await new Promise(r => setTimeout(r, 500));

      // Find and click "Continue to payment" in the modal
      const modal = document.querySelector('.MuiDialog-root');
      if (!modal) {
        console.log('Modal did not appear');
        return false;
      }

      const continueBtn = modal.querySelector('.MuiDialogActions-root button') as HTMLElement;
      if (!continueBtn) {
        console.log('Could not find "Continue to payment" button in modal');
        return false;
      }

      console.log('Clicking "Continue to payment" button in modal...');
      continueBtn.click();

      // Wait for navigation
      await new Promise(r => setTimeout(r, 1500));

      return true;
    } catch (error) {
      console.error('Error handling alternate add-ons page:', error);
      return false;
    }
  }

  /**
   * The payoff step: fill and submit the payment page.
   *
   * Why this is convoluted: card and billing fields live inside *cross-origin* Stripe
   * iframes (Payment Element = card/expiry/CVC in one iframe; Address Element =
   * name/address in a second), which a content script legally cannot read or type
   * into. So instead of injecting values we compute each iframe's viewport rectangle
   * and POST those coordinates + the card/billing details to the local automation
   * server (localhost:3847 /trigger-cvc), which uses OS-level AppleScript+cliclick to
   * click and keystroke into the real fields. Legacy Braintree (single CVC iframe) is
   * detected as a fallback and flagged via `isStripe:false`.
   *
   * Coordinate quirk: for Stripe we aim ~30px below the iframe top (the card-number
   * row) rather than its center, since the payment iframe stacks card/expiry/CVC.
   *
   * After triggering we wait a fixed ~8s for the server to finish typing, then click
   * the purchase button. An Enter-key listener is also armed as a manual fallback so a
   * human can submit if the server never responds. Returns true once setup/handoff is
   * done (not a guarantee the charge succeeded).
   */
  private async handlePurchaseConfirmation(): Promise<boolean> {
    try {
      console.log('🔧 Setting up purchase confirmation page...');

      // Step 0: Handle gratuity if present
      await this.handleGratuitySelection();

      // Step 1: Check all consent checkboxes
      await this.checkPurchaseCheckboxes();

      // Step 2: Detect payment provider and find the payment iframe
      const stripePaymentIframe = document.querySelector('[data-testid="payment"] iframe, .StripeElement iframe') as HTMLIFrameElement;
      const braintreeCvcIframe = document.querySelector('#braintree-hosted-field-cvv') as HTMLIFrameElement;

      const paymentIframe = stripePaymentIframe || braintreeCvcIframe;
      const isStripe = !!stripePaymentIframe;

      if (paymentIframe) {
        console.log(`💳 ${isStripe ? 'Stripe Payment Element' : 'Braintree CVC field'} detected`);

        // Scroll into view
        paymentIframe.scrollIntoView({ behavior: 'instant', block: 'center' });
        await new Promise(r => setTimeout(r, 200));

        // Visual highlight
        const container = isStripe
          ? (paymentIframe.closest('.StripeElement') || paymentIframe.parentElement) as HTMLElement
          : paymentIframe;
        if (container) {
          container.style.outline = '3px solid #ff6b00';
          container.style.outlineOffset = '2px';
          container.style.boxShadow = '0 0 10px rgba(255, 107, 0, 0.5)';
        }
      } else {
        console.log('⚠️ No payment iframe found (Stripe or Braintree)');
      }

      // Step 3: Set up Enter key fallback to click purchase button
      const purchaseButton = document.querySelector('[data-testid="purchase-button"]') as HTMLElement;
      if (!purchaseButton) {
        console.log('❌ Purchase button not found');
        return false;
      }

      const handleKeyDown = (event: KeyboardEvent) => {
        if (event.key === 'Enter') {
          console.log('⏎ Enter key detected! Clicking purchase button...');
          event.preventDefault();
          document.removeEventListener('keydown', handleKeyDown);
          purchaseButton.click();
        }
      };
      document.addEventListener('keydown', handleKeyDown);

      // Step 4: Trigger the card automation server
      console.log('🤖 Triggering card automation server...');
      try {
        // Get coordinates of the payment iframe (card number field area)
        const targetIframe = paymentIframe;
        let requestBody: Record<string, any> = { isStripe };

        // Send card details from extension preferences so server doesn't need config file
        if (this.preferences.cardNumber) requestBody.cardNumber = this.preferences.cardNumber;
        if (this.preferences.cardExpiry) requestBody.cardExpiry = this.preferences.cardExpiry;
        if (this.preferences.cvc) requestBody.cvc = this.preferences.cvc;

        // Send billing details
        if (this.preferences.billingName) requestBody.billingName = this.preferences.billingName;
        if (this.preferences.billingAddress) requestBody.billingAddress = this.preferences.billingAddress;
        if (this.preferences.billingCity) requestBody.billingCity = this.preferences.billingCity;
        if (this.preferences.billingState) requestBody.billingState = this.preferences.billingState;
        if (this.preferences.billingZip) requestBody.billingZip = this.preferences.billingZip;

        if (targetIframe) {
          const rect = targetIframe.getBoundingClientRect();
          // For Stripe: click near the top of the iframe where card number field is
          requestBody.x = Math.round(rect.left + rect.width / 2);
          requestBody.y = Math.round(rect.top + (isStripe ? 30 : rect.height / 2));
          requestBody.iframeWidth = Math.round(rect.width);
          requestBody.iframeHeight = Math.round(rect.height);
          console.log(`📍 Payment iframe at: (${requestBody.x}, ${requestBody.y}), size: ${requestBody.iframeWidth}x${requestBody.iframeHeight}`);
        }

        // Get billing address iframe coordinates (separate Stripe iframe)
        if (isStripe) {
          const billingIframe = document.querySelector('[data-testid="billing"] iframe') as HTMLIFrameElement;
          if (billingIframe) {
            const bRect = billingIframe.getBoundingClientRect();
            requestBody.billingIframeX = Math.round(bRect.left);
            requestBody.billingIframeY = Math.round(bRect.top);
            requestBody.billingIframeWidth = Math.round(bRect.width);
            requestBody.billingIframeHeight = Math.round(bRect.height);
            console.log(`📍 Billing iframe at: (${requestBody.billingIframeX}, ${requestBody.billingIframeY}), size: ${requestBody.billingIframeWidth}x${requestBody.billingIframeHeight}`);
          }
        }

        const response = await fetch('http://localhost:3847/trigger-cvc', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(requestBody)
        });
        const result = await response.json();
        if (result.success) {
          console.log('✅ Card automation triggered successfully!');

          // Wait for card + billing details to be typed, then click purchase
          await new Promise(resolve => setTimeout(resolve, 8000));

          const purchaseBtn = document.querySelector('[data-testid="purchase-button"]') as HTMLElement;
          if (purchaseBtn) {
            console.log('🛒 Clicking purchase button...');
            document.removeEventListener('keydown', handleKeyDown);
            purchaseBtn.click();
            console.log('✅ Purchase button clicked!');
          }
        } else {
          console.log('⚠️ Card automation failed:', result.error);
          console.log('💡 Make sure the server is running: node scripts/cvc-server.js');
        }
      } catch (error) {
        console.log('⚠️ Could not reach card automation server');
        console.log('💡 Start the server with: node scripts/cvc-server.js');
        console.log('🔑 Or manually fill card details and press Enter');
      }

      return true;
    } catch (error) {
      console.error('Error setting up purchase confirmation:', error);
      return false;
    }
  }

  /**
   * Handle gratuity selection on purchase confirmation page
   * Defaults to "No gratuity" if the option is present
   */
  private async handleGratuitySelection(): Promise<void> {
    const noGratuityBtn = document.querySelector('[data-testid="gratuity-button-zero"]') as HTMLElement;

    if (!noGratuityBtn) {
      console.log('💰 No gratuity option found (may not be present on this page)');
      return;
    }

    // Check if already selected
    if (noGratuityBtn.getAttribute('aria-pressed') === 'true') {
      console.log('✅ "No gratuity" already selected');
      return;
    }

    console.log('💰 Selecting "No gratuity" option...');
    noGratuityBtn.click();
    await new Promise(r => setTimeout(r, 100));
    console.log('✅ "No gratuity" selected');
  }

  /**
   * Tick the required consent checkboxes (terms-of-service, marketing opt-in) so the
   * purchase button enables.
   *
   * Only real `type="checkbox"` inputs are clicked — the selectors also match label
   * headings, and clicking those would toggle nothing or scroll focus. Missing boxes
   * are treated as optional (not every event has both), and already-checked ones are
   * left alone to avoid un-checking.
   */
  private async checkPurchaseCheckboxes(): Promise<void> {
    console.log('☑️ Checking consent checkboxes...');

    // Only target actual checkbox inputs, not headings
    const checkboxSelectors = [
      '[data-testid="checkout-consents-to-text"]',
      '[data-testid="checkout-opt-in-email"]'
    ];

    for (const selector of checkboxSelectors) {
      const checkbox = document.querySelector(selector) as HTMLInputElement;

      if (checkbox && checkbox.type === 'checkbox') {
        if (!checkbox.checked) {
          console.log(`Checking: ${selector}`);
          checkbox.click();
          await new Promise(r => setTimeout(r, 100));
        } else {
          console.log(`Already checked: ${selector}`);
        }
      } else {
        console.log(`Checkbox not found (may be optional): ${selector}`);
      }
    }

    console.log('☑️ Checkboxes processed');
  }
} 