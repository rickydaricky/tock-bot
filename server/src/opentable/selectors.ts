/**
 * Central OpenTable selector registry. The `profile` selectors are verified against
 * the extension's OpenTableFormFiller and opentable-nopa.html. The `checkout` selectors
 * are captured by the recon spike (Task 10) — until then their values are the best
 * current guess and MUST be re-verified against the live authenticated booking page.
 */
export const OT_SELECTORS = {
  profile: {
    partySizeSelect: '#restaurantProfileDtpPartySizePicker',
    dayPickerOverlay: '[data-testid="day-picker-overlay"]',
    dayPickerNext: '[name="next-month"]',
    dayPickerPrev: '[name="previous-month"]',
    dayPickerCaption: '.rdp-caption [aria-live="polite"]',
    timeSelect: 'select[id$="timePickerDtpPicker"]', // real id: restaurantProfiletimePickerDtpPicker
    timeSlot: '[data-testid^="time-slot-"]',
    timeSlotButton: '[data-testid^="time-slot-"] [role="button"]',
  },
  checkout: {
    // POPULATED BY RECON (Task 10). Provisional values below — do not ship a real
    // (non-dry) paid booking until these are recon-verified.
    completeReservationButton: '[data-testid="complete-reservation-button"]',
    firstNameInput: 'input[name="firstName"], input[autocomplete="given-name"]',
    lastNameInput: 'input[name="lastName"], input[autocomplete="family-name"]',
    phoneInput: 'input[type="tel"], input[autocomplete="tel"]',
    amountDueTextRoot: 'body',
    stripeCardIframe: 'iframe[src*="stripe"], iframe[title*="Secure card" i]',
  },
} as const;
