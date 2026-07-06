/**
 * stripe.ts — payment-details storage/override + Stripe checkout autofill.
 *
 * Single responsibility: own the card/billing "source of truth" for headless
 * server-side booking and drive the values into Tock's Stripe Elements at
 * checkout time.
 *
 * Role in the system: the auto-purchase step of the sniper/booker flow calls
 * `getPayment()` to resolve which card to use, then `fillStripePayment()` +
 * `fillStripeBilling()` to type it into the Stripe Payment Element and Address
 * Element on Tock's checkout page. This is the SERVER (headless Playwright)
 * counterpart to the Chrome extension's cross-origin approach: because the
 * server drives a real Playwright browser it can reach directly into the Stripe
 * iframes and fill them, so it does NOT need the AppleScript+cliclick coordinate
 * server (`scripts/cvc-server.js`) that the extension relies on.
 *
 * Key exports:
 *  - `PaymentDetails`      — shape of a resolved card + billing address.
 *  - `setPaymentOverride`  — persist card details supplied from the dashboard UI.
 *  - `getPayment`          — resolve the active card (disk override → env vars).
 *  - `getPaymentFromEnv`   — read card details from CARD_ and BILLING_ env vars.
 *  - `fillStripePayment`   — fill card number / expiry / CVC in the Payment Element.
 *  - `fillStripeBilling`   — fill name / address / city / state / ZIP in the Address Element.
 */
import { Page, Frame } from 'playwright';
import { saveToDisk, loadFromDisk } from './store';

/**
 * A fully-resolved set of payment + billing values ready to type into Stripe.
 * All fields are plain strings so they can be persisted to disk / read from env
 * without transformation; format-sensitive fields note their expected shape.
 */
export interface PaymentDetails {
  cardNumber: string;
  cardExpiry: string; // MM/YY
  cvc: string;
  billingName: string;
  billingAddress: string;
  billingCity: string;
  billingState: string; // 2-letter code
  billingZip: string;
}

/**
 * Persist card details supplied from the dashboard UI as the active override.
 * Written to disk (via `store`) so it survives restarts and takes priority over
 * env-var config on the next `getPayment()` call.
 */
export function setPaymentOverride(payment: PaymentDetails): void {
  saveToDisk('payment', payment);
}

/**
 * Resolve the card to charge, in priority order: disk override (set from the UI)
 * → env vars. The disk override only "counts" if it has a non-empty cardNumber,
 * so a partially-written/blank record falls through to env instead of booking
 * with an empty card. Returns null when neither source yields a usable card.
 */
export function getPayment(): PaymentDetails | null {
  const fromDisk = loadFromDisk('payment') as PaymentDetails | null;
  if (fromDisk?.cardNumber) return fromDisk;
  return getPaymentFromEnv();
}

/**
 * Load payment details from environment variables (the deploy-time fallback used
 * when no UI override is set). Card number + CVC are the required minimum — if
 * either is missing we treat env config as absent and return null. Every other
 * field defaults to '' so a partial billing config still yields a usable object
 * (Stripe will surface any missing-billing errors at checkout).
 */
export function getPaymentFromEnv(): PaymentDetails | null {
  const cardNumber = process.env.CARD_NUMBER;
  const cvc = process.env.CARD_CVC;
  if (!cardNumber || !cvc) return null;

  return {
    cardNumber,
    cardExpiry: process.env.CARD_EXPIRY || '',
    cvc,
    billingName: process.env.BILLING_NAME || '',
    billingAddress: process.env.BILLING_ADDRESS || '',
    billingCity: process.env.BILLING_CITY || '',
    billingState: process.env.BILLING_STATE || '',
    billingZip: process.env.BILLING_ZIP || '',
  };
}

/**
 * Locate whichever Stripe iframe currently contains a given input, by probing
 * every frame on the page for `input[name="${fieldName}"]`.
 *
 * Why probe-by-content instead of a CSS/frame selector: Stripe mounts its
 * Elements in dynamically-named, nested cross-origin iframes whose structure and
 * IDs are not stable, so targeting a specific frame selector is brittle. Passing
 * the distinctive field name ('number' for the Payment Element, 'name' for the
 * Address Element) reliably identifies the right frame regardless of nesting.
 *
 * Polls (500ms cadence, up to `timeoutMs`) because the frames are injected
 * asynchronously after page load, so the field usually isn't present on the
 * first pass. Frames from unrelated cross-origin sources can throw on `.count()`
 * (access denied); those are swallowed so one inaccessible frame doesn't abort
 * the search. Returns null if the field never appears within the timeout.
 */
async function findStripeFrame(page: Page, fieldName: string, timeoutMs = 15000): Promise<Frame | null> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    for (const frame of page.frames()) {
      try {
        const found = await frame.locator(`input[name="${fieldName}"]`).count();
        if (found > 0) return frame;
      } catch { /* skip inaccessible frames */ }
    }
    await page.waitForTimeout(500);
  }
  return null;
}

/**
 * Fill the Stripe Payment Element (card number, expiry, CVC) in a headless
 * Playwright page. Throws if the payment iframe never mounts.
 *
 * Each field is click-focused before `.fill()` and separated by short waits:
 * Stripe attaches input masking/validation listeners lazily, and firing values
 * too fast can drop keystrokes or leave the field flagged invalid. The click +
 * wait pattern (especially the longer 300/500ms around the card number) gives
 * Stripe time to initialize the field before we type. Expiry is stripped to bare
 * digits (`MM/YY` → `MMYY`) because the Element inserts the slash itself; feeding
 * the slash would double it.
 */
export async function fillStripePayment(page: Page, payment: PaymentDetails): Promise<void> {
  console.log('💳 Filling Stripe Payment Element...');

  // Find the frame containing the card number input
  const frame = await findStripeFrame(page, 'number');
  if (!frame) {
    throw new Error('Could not find Stripe payment frame (no input[name="number"] in any frame)');
  }
  console.log('   Found payment frame');

  const cardField = frame.locator('input[name="number"]');
  const expiryField = frame.locator('input[name="expiry"]');
  const cvcField = frame.locator('input[name="cvc"]');

  await cardField.click();
  await page.waitForTimeout(300);
  await cardField.fill(payment.cardNumber);
  await page.waitForTimeout(500);

  await expiryField.click();
  await page.waitForTimeout(200);
  // Strip any separators — the Element renders its own slash between MM and YY.
  const expiryDigits = payment.cardExpiry.replace(/\D/g, '');
  await expiryField.fill(expiryDigits);
  await page.waitForTimeout(200);

  await cvcField.click();
  await page.waitForTimeout(200);
  await cvcField.fill(payment.cvc);
  await page.waitForTimeout(200);

  console.log('✅ Payment fields filled');
}

/**
 * Fill the Stripe Address Element (billing name, address, city, state, ZIP) in a
 * headless Playwright page. Throws if the billing iframe never mounts.
 *
 * Same click-then-fill-with-waits discipline as `fillStripePayment`, plus two
 * Address-Element-specific quirks handled inline below: an Escape after the
 * street address to dismiss the Google Places autocomplete dropdown (otherwise
 * it can hijack focus / overwrite the field), and a three-tier fallback for the
 * state `<select>` (value → label → type-and-Enter) since the option encoding
 * varies. State must be a 2-letter code for the value/type paths to match.
 */
export async function fillStripeBilling(page: Page, payment: PaymentDetails): Promise<void> {
  console.log('📍 Filling Stripe Billing Address...');

  // Find the frame containing the billing name input
  const frame = await findStripeFrame(page, 'name');
  if (!frame) {
    throw new Error('Could not find Stripe billing frame (no input[name="name"] in any frame)');
  }
  console.log('   Found billing frame');

  // Name
  const nameField = frame.locator('input[name="name"]');
  await nameField.click();
  await page.waitForTimeout(200);
  await nameField.fill(payment.billingName);
  await page.waitForTimeout(300);

  // Address line 1
  const addressField = frame.locator('input[name="addressLine1"]');
  await addressField.click();
  await page.waitForTimeout(200);
  await addressField.fill(payment.billingAddress);
  await page.waitForTimeout(500);

  // Dismiss Google Places autocomplete dropdown
  await page.keyboard.press('Escape');
  await page.waitForTimeout(300);

  // City
  const cityField = frame.locator('input[name="locality"]');
  await cityField.click();
  await page.waitForTimeout(200);
  await cityField.fill(payment.billingCity);
  await page.waitForTimeout(200);

  // State dropdown — try the fastest match first and degrade on failure:
  // 1) option value = 2-letter code, 2) option label = whatever was passed,
  // 3) open the native <select> and type the code + Enter as a last resort.
  const stateField = frame.locator('select[name="administrativeArea"]');
  try {
    await stateField.selectOption({ value: payment.billingState }, { timeout: 3000 });
  } catch {
    try {
      await stateField.selectOption({ label: payment.billingState }, { timeout: 3000 });
    } catch {
      await stateField.click();
      await page.keyboard.type(payment.billingState);
      await page.keyboard.press('Enter');
    }
  }
  await page.waitForTimeout(200);

  // ZIP code
  const zipField = frame.locator('input[name="postalCode"]');
  await zipField.click();
  await page.waitForTimeout(200);
  await zipField.fill(payment.billingZip);
  await page.waitForTimeout(200);

  console.log('✅ Billing address filled');
}
