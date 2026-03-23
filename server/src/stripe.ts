import { Page } from 'playwright';
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
 * Fill the Stripe Payment Element (card number, expiry, CVC).
 *
 * Playwright can access cross-origin iframe internals via frameLocator,
 * unlike Chrome extension content scripts.
 */
export async function fillStripePayment(page: Page, payment: PaymentDetails): Promise<void> {
  console.log('💳 Filling Stripe Payment Element...');

  // The payment iframe is inside [data-testid="payment"] or a .StripeElement
  const paymentFrame = page.frameLocator('[data-testid="payment"] iframe').first();

  // Stripe Payment Element field selectors — try multiple patterns
  // Stripe uses different name/placeholder attributes across versions
  const cardField = paymentFrame.locator('input[name="number"], input[name="cardNumber"], input[placeholder*="Card number"], input[autocomplete="cc-number"]').first();
  const expiryField = paymentFrame.locator('input[name="expiry"], input[name="cardExpiry"], input[placeholder*="MM"], input[autocomplete="cc-exp"]').first();
  const cvcField = paymentFrame.locator('input[name="cvc"], input[name="cardCvc"], input[placeholder*="CVC"], input[autocomplete="cc-csc"]').first();

  await cardField.click();
  await page.waitForTimeout(300);
  await cardField.fill(payment.cardNumber);
  await page.waitForTimeout(300);

  await expiryField.click();
  await page.waitForTimeout(200);
  // Stripe expects MMYY without slash
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

  const billingFrame = page.frameLocator('[data-testid="billing"] iframe').first();

  // Name field
  const nameField = billingFrame.locator('input[name="name"], input[autocomplete="name"]').first();
  await nameField.click();
  await page.waitForTimeout(200);
  await nameField.fill(payment.billingName);
  await page.waitForTimeout(300);

  // Address line 1
  const addressField = billingFrame.locator('input[name="addressLine1"], input[autocomplete="address-line1"]').first();
  await addressField.click();
  await page.waitForTimeout(200);
  await addressField.fill(payment.billingAddress);
  await page.waitForTimeout(500);

  // Dismiss Google Places autocomplete dropdown
  await page.keyboard.press('Escape');
  await page.waitForTimeout(300);

  // City
  const cityField = billingFrame.locator('input[name="locality"], input[autocomplete="address-level2"]').first();
  await cityField.click();
  await page.waitForTimeout(200);
  await cityField.fill(payment.billingCity);
  await page.waitForTimeout(200);

  // State dropdown — try by value, then by label (Stripe may use full state names or abbreviations)
  const stateField = billingFrame.locator('select[name="administrativeArea"], select[autocomplete="address-level1"]').first();
  try {
    await stateField.selectOption({ value: payment.billingState }, { timeout: 3000 });
  } catch {
    try {
      await stateField.selectOption({ label: payment.billingState }, { timeout: 3000 });
    } catch {
      // Last resort: click and type to filter
      await stateField.click();
      await page.keyboard.type(payment.billingState);
      await page.keyboard.press('Enter');
    }
  }
  await page.waitForTimeout(200);

  // ZIP code
  const zipField = billingFrame.locator('input[name="postalCode"], input[autocomplete="postal-code"]').first();
  await zipField.click();
  await page.waitForTimeout(200);
  await zipField.fill(payment.billingZip);
  await page.waitForTimeout(200);

  console.log('✅ Billing address filled');
}
