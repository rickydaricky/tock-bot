// server/src/opentable/checkout.ts
import { Page } from 'playwright';
import { BookingRequest } from '../booker';

export interface CheckoutOutcome { success: boolean; error?: string; heldOnly?: boolean; }

/** STUB until Task 10 recon. Fail-closed: holds the slot but does not purchase. */
export async function handleOpenTableCheckout(_page: Page, _req: BookingRequest, screenshots: string[]): Promise<CheckoutOutcome> {
  try { screenshots.push((await _page.screenshot({ fullPage: false })).toString('base64')); } catch { /* best effort */ }
  return { success: false, heldOnly: true, error: 'Checkout not yet implemented (Task 10) — slot reached, not purchased.' };
}
