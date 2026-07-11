/**
 * Freeze-on-failure recovery registry.
 *
 * Single responsibility: when a sniper grab succeeds but the auto-purchase step
 * fails, we do NOT tear down the winning browser. Instead we "freeze" it — the
 * won slot is still held by Tock for ~10 minutes — and park the live Page in an
 * in-memory registry so the operator can finish the checkout by hand through the
 * dashboard's Live Sessions panel (re-enter CVC, retry purchase, view a fresh
 * screenshot, or abort).
 *
 * Role in the system: this is the manual-rescue safety net behind the automated
 * sniper/booker pipeline. index.ts exposes these calls over HTTP; the sniper
 * calls freezeSession() on purchase failure.
 *
 * Design split: the registry bookkeeping (freeze / list / get / abort / sweep)
 * is browser-agnostic and unit-tested against a fake SessionHandle, while the
 * page-driven actions at the bottom operate on the real live Playwright Page.
 *
 * Key exports:
 *  - freezeSession / listSessions / getSession / abortSession — registry CRUD
 *  - applyAction — run a canned recovery action against a frozen session's page
 *  - sessionScreenshot — capture the frozen page for the dashboard
 *  - SessionStatus / SessionHandle / FreezeInput / PublicSession / SessionAction — public types
 *  - _setNow / _reset / _sweep — test/maintenance seams (underscore-prefixed)
 */

import type { Page } from 'playwright';
import { handlePurchaseFlow } from './booker';
import { getPayment } from './stripe';

/** Lifecycle of a frozen recovery session. */
export type SessionStatus = 'frozen' | 'cvc-filled' | 'retry-failed';

/**
 * The two live browser objects we must retain to recover a frozen session:
 * the `browser` (so we can close it on abort/TTL and never leak a headless
 * Chromium) and the `page` still parked on Tock's checkout. Structurally typed
 * (not the concrete Playwright Browser) so tests can inject a fake handle.
 */
export interface SessionHandle {
  browser: { close(): Promise<void> };
  page: Page;
}

/** Everything the caller (the sniper) supplies when parking a failed purchase. */
export interface FreezeInput {
  handle: SessionHandle;
  restaurant: string;
  bookedDate?: string;
  bookedTime?: string;
  error?: string;
  /**
   * Fail-closed grand-total cap in cents carried over from the sniper run. The
   * manual 'retry-purchase' action forwards this to handlePurchaseFlow so a
   * human-triggered retry still enforces the same overspend guard the automated
   * path uses — never leaving the exact page FHH lands on unguarded. Undefined
   * means no cap (matches handlePurchaseFlow's optional-cap semantics), which is
   * only ever the case for a dry run.
   */
  maxPriceCents?: number;
  /**
   * A *guessed* per-person price (cents) when this session was won via a
   * speculative f6/price-fan candidate rather than the known-good price. Drives
   * a RED "GUESSED PRICE — verify $X" banner on the dashboard so the operator
   * double-checks the amount before completing checkout. Purely informational —
   * the fail-closed maxPriceCents cap above still gates the actual spend.
   */
  guessedPriceCents?: number;
  /** Override the default hold window; primarily a test seam. */
  ttlMs?: number;
}

/** Internal stored record: a FreezeInput plus assigned id, status, and clock stamp. */
interface Entry extends FreezeInput {
  id: string;
  status: SessionStatus;
  createdAt: number;
  ttlMs: number;
}

// Empirical: Tock holds a locked slot ~10 min after the grab, so a frozen
// session is only useful within that window — after it, the slot is gone and
// keeping the browser open just wastes memory. _sweep() enforces this.
const DEFAULT_TTL = 10 * 60 * 1000; // ~Tock hold window
// Process-lifetime registry. In-memory only: a server restart drops every
// frozen session (acceptable — the slot has almost always expired by then).
const sessions = new Map<string, Entry>();
let nowFn: () => number = () => Date.now();
// Monotonic id source; combined with the timestamp to keep ids unique/sortable.
let counter = 0;

/** Test seam: override the clock for deterministic age/TTL assertions. */
export function _setNow(fn: () => number): void { nowFn = fn; }
/** Test seam: clear the registry between tests. */
export function _reset(): void { sessions.clear(); counter = 0; }

/**
 * Park a winning-but-unpurchased browser session and return its id.
 * The caller keeps the browser/page alive by handing over the SessionHandle;
 * from here it lives in the registry until abort, a successful retry, or the
 * TTL sweep closes it. Status starts at 'frozen'.
 */
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

/**
 * Dashboard-safe view of a session: deliberately omits the live handle (browser
 * + page) so we never serialize non-JSON internals over HTTP. `ageMs` is
 * derived at read time rather than stored, so the panel can show a live countdown.
 */
export interface PublicSession {
  id: string;
  restaurant: string;
  bookedDate?: string;
  bookedTime?: string;
  status: SessionStatus;
  ageMs: number;
  error?: string;
  /**
   * Present only when the slot was won on a speculative price fan; the dashboard
   * renders a RED "GUESSED PRICE — verify $X" banner from it. Omitted (undefined)
   * for the normal known-price path so no banner shows.
   */
  guessedPriceCents?: number;
}

/** Snapshot of all frozen sessions for the dashboard Live Sessions panel. */
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
    guessedPriceCents: e.guessedPriceCents,
  }));
}

/**
 * Internal full record including the live handle (unlike listSessions' public
 * view). Used by page-driven actions that need the actual browser/page.
 */
export function getSession(id: string): Entry | undefined {
  return sessions.get(id);
}

/**
 * Drop a session and close its browser. Idempotent-ish: returns false if the id
 * is unknown. We delete from the registry BEFORE closing so a slow/failed
 * browser.close() can't leave a dangling entry, and swallow close errors since
 * the browser may already be gone (e.g. crashed or swept).
 */
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

/** The canned recovery buttons the dashboard exposes for a frozen session. */
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
      // Explicit value from the operator wins; otherwise fall back to the
      // configured card's CVC. A common freeze cause is a mistyped/rejected CVC.
      const cvc = value ?? getPayment()?.cvc;
      if (!cvc) return { ok: false, error: 'no CVC provided or configured' };
      // Card fields live in a cross-origin payment iframe (Stripe or, on some
      // venues, Braintree). Match the frame by URL, then fall back to the top
      // page if none is found (e.g. an inline/non-iframe field variant).
      const frame = page.frames().find((f: any) => /stripe|braintree/.test(f.url()));
      const target = frame ?? page;
      // The CVC input's name/placeholder/autocomplete varies across providers,
      // so try the union of known selectors and take the first match.
      const input = target.locator('input[name="cvv"], input[name="cvc"], input[placeholder="CVC"], input[autocomplete="cc-csc"]').first();
      await input.click({ timeout: 5000 });
      await input.fill(cvc);
      e.status = 'cvc-filled';
      return { ok: true };
    }

    if (action === 'retry-purchase') {
      // Re-run the full booker checkout on the live page, threading the frozen
      // session's maxPriceCents so a human-triggered retry STILL fail-closes on
      // overspend. A manual retry lands on the exact checkout page FHH freezes
      // into ($258×2), so dropping the cap here would make freeze-for-manual an
      // unguarded-spend path — the very hole this closes. Undefined cap (dry-run
      // origin only) preserves the prior no-cap behavior.
      const ok = await handlePurchaseFlow(page, false, [], e.maxPriceCents);
      if (ok) { await abortSession(id); return { ok: true }; }   // success → release/close
      e.status = 'retry-failed';
      return { ok: false, error: 'retry purchase did not complete (timeout, payment step failed, or price over cap) — check the live screenshot' };
    }

    return { ok: false, error: `unknown action: ${action}` };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
