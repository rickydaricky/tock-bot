// Registry of frozen booking sessions: when a sniper grab succeeds but the
// purchase fails, we keep the winning browser alive (slot still held ~10 min)
// so the user can recover it via canned dashboard actions. Page-driven actions
// (re-enter-cvc, retry-purchase, screenshot) live in this module too; the
// registry bookkeeping below is browser-agnostic and unit-tested with a fake handle.

import type { Page } from 'playwright';
import { handlePurchaseFlow } from './booker';
import { getPayment } from './stripe';

/** Lifecycle of a frozen recovery session. */
export type SessionStatus = 'frozen' | 'cvc-filled' | 'retry-failed';

export interface SessionHandle {
  browser: { close(): Promise<void> };
  page: Page;
}

export interface FreezeInput {
  handle: SessionHandle;
  restaurant: string;
  bookedDate?: string;
  bookedTime?: string;
  error?: string;
  ttlMs?: number;
}

interface Entry extends FreezeInput {
  id: string;
  status: SessionStatus;
  createdAt: number;
  ttlMs: number;
}

const DEFAULT_TTL = 10 * 60 * 1000; // ~Tock hold window
const sessions = new Map<string, Entry>();
let nowFn: () => number = () => Date.now();
let counter = 0;

/** Test seam: override the clock for deterministic age/TTL assertions. */
export function _setNow(fn: () => number): void { nowFn = fn; }
/** Test seam: clear the registry between tests. */
export function _reset(): void { sessions.clear(); counter = 0; }

export function freezeSession(input: FreezeInput): string {
  const id = `s${++counter}_${nowFn()}`;
  sessions.set(id, {
    ...input,
    id,
    status: 'frozen',
    createdAt: nowFn(),
    ttlMs: input.ttlMs ?? DEFAULT_TTL,
  });
  return id;
}

export interface PublicSession {
  id: string;
  restaurant: string;
  bookedDate?: string;
  bookedTime?: string;
  status: SessionStatus;
  ageMs: number;
  error?: string;
}

export function listSessions(): PublicSession[] {
  const t = nowFn();
  return [...sessions.values()].map(e => ({
    id: e.id,
    restaurant: e.restaurant,
    bookedDate: e.bookedDate,
    bookedTime: e.bookedTime,
    status: e.status,
    ageMs: t - e.createdAt,
    error: e.error,
  }));
}

export function getSession(id: string): Entry | undefined {
  return sessions.get(id);
}

export async function abortSession(id: string): Promise<boolean> {
  const e = sessions.get(id);
  if (!e) return false;
  sessions.delete(id);
  try { await e.handle.browser.close(); } catch { /* already gone */ }
  return true;
}

/** Close + drop any session past its TTL (so we never leak a headless browser). */
export function _sweep(): void {
  const t = nowFn();
  for (const e of [...sessions.values()]) {
    if (t - e.createdAt > e.ttlMs) { void abortSession(e.id); }
  }
}

// Periodic sweep in production. unref so it never keeps the process alive.
const sweepTimer = setInterval(() => _sweep(), 30_000);
sweepTimer.unref?.();

// --- Page-driven recovery actions (operate on the live frozen browser) ---

/** Fresh screenshot of a frozen session's page, or null. */
export async function sessionScreenshot(id: string): Promise<string | null> {
  const e = sessions.get(id);
  if (!e) return null;
  try { return (await e.handle.page.screenshot({ fullPage: false })).toString('base64'); }
  catch { return null; }
}

export type SessionAction = 're-enter-cvc' | 'retry-purchase' | 'refresh-screenshot' | 'abort';

/** Apply a canned recovery action to a frozen session's live page. */
export async function applyAction(id: string, action: SessionAction, value?: string): Promise<{ ok: boolean; error?: string }> {
  const e = sessions.get(id);
  if (!e) return { ok: false, error: 'session not found' };
  const page = e.handle.page;
  try {
    if (action === 'abort') { await abortSession(id); return { ok: true }; }
    if (action === 'refresh-screenshot') { return { ok: true }; } // caller re-fetches /screenshot

    if (action === 're-enter-cvc') {
      const cvc = value ?? getPayment()?.cvc;
      if (!cvc) return { ok: false, error: 'no CVC provided or configured' };
      const frame = page.frames().find((f: any) => /stripe|braintree/.test(f.url()));
      const target = frame ?? page;
      const input = target.locator('input[name="cvv"], input[name="cvc"], input[placeholder="CVC"], input[autocomplete="cc-csc"]').first();
      await input.click({ timeout: 5000 });
      await input.fill(cvc);
      e.status = 'cvc-filled';
      return { ok: true };
    }

    if (action === 'retry-purchase') {
      const ok = await handlePurchaseFlow(page, false, []);
      if (ok) { await abortSession(id); return { ok: true }; }   // success → release/close
      e.status = 'retry-failed';
      return { ok: false, error: 'retry purchase did not complete (timeout or payment step failed) — check the live screenshot' };
    }

    return { ok: false, error: `unknown action: ${action}` };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
