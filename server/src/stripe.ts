import { Page, Frame } from 'playwright';
import { saveToDisk, loadFromDisk } from './store';

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

export function setPaymentOverride(payment: PaymentDetails): void {
  saveToDisk('payment', payment);
}

/** Get payment details — disk (from UI) → env vars */
export function getPayment(): PaymentDetails | null {
  const fromDisk = loadFromDisk('payment') as PaymentDetails | null;
  if (fromDisk?.cardNumber) return fromDisk;
  return getPaymentFromEnv();
}

/** Load payment details from environment variables */
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
 * Find the Stripe payment frame by searching all frames for the card number input.
 * More reliable than CSS selectors since Stripe nests iframes unpredictably.
 */
async function findStripeFrame(page: Page, fieldName: string): Promise<Frame | null> {
  for (const frame of page.frames()) {
    try {
      const found = await frame.locator(`input[name="${fieldName}"]`).count();
      if (found > 0) return frame;
    } catch { /* skip inaccessible frames */ }
  }
  return null;
}

/**
 * Fill the Stripe Payment Element (card number, expiry, CVC).
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
 * Fill the Stripe Address Element (billing name, address, city, state, ZIP).
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

  // State dropdown
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
