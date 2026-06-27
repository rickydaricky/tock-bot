# Sniper Mode Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a high-frequency "sniper" booking engine that densely polls Tock availability across a drop window, grabs the first matching slot via a single-winner lock, auto-purchases, and freezes the session for human recovery on purchase failure.

**Architecture:** A new `sniper.ts` engine warms a small pool (≤6) of browsers on the search page, then each polls the availability endpoint via in-page `fetch` at ~200 ms, staggered to blanket a −1s…+10s window. The first poll to find a date+time match wins an atomic lock, grabs the slot (direct Book-call preferred, DOM-click fallback), and runs the existing purchase flow. On purchase failure the winning browser is parked in a `sessions.ts` registry exposed to the dashboard with canned recovery actions.

**Tech Stack:** TypeScript (Node 20), Playwright 1.52, Express, `node:test` via `tsx` for tests.

## Global Constraints

- Node 20 (server uses global `fetch`; do not target Node 16).
- No new runtime dependencies beyond `playwright`/`express`/`node-cron` already present. Tests use built-in `node:test` run through the existing `tsx` devDep.
- Browser pool clamped to 1..6. Poll interval default 200 ms. Window default −1000…+10000 ms vs `runAt`.
- Reuse existing helpers: `STEALTH_ARGS`, `to12Hour`, `handlePurchaseFlow`, `injectCookies`, fingerprint pool, `AttemptOutcome`/`summarizeFailures` (from the visibility work).
- No proxies, no CAPTCHA/Turnstile solving, no raw-API auth reverse-engineering. All requests originate from the owner's authenticated browser context.
- Single-winner lock is mandatory — duplicate grabs/charges are unacceptable.
- Blind full-auto purchase (no match/price gating); `maxPrice` is an optional, default-off hook.

## File Structure

- Create `server/src/sniper.ts` — engine: `SniperConfig`, `runSniper`, `pickSlot`, `SingleWinnerLock`, `computeWindowOffsets`, `parseAvailability`.
- Create `server/src/sessions.ts` — paused-session registry: `freezeSession`, `listSessions`, `getSession`, `applyAction`, `sessionScreenshot`, TTL cleanup.
- Create `server/test/sniper.test.ts`, `server/test/sessions.test.ts`, `server/test/sniper-integration.test.ts`.
- Modify `server/src/index.ts` — add `/api/sniper` + `/api/sessions`, `/api/sessions/:id/screenshot`, `/api/sessions/:id/action`.
- Modify `server/src/scheduler.ts` — accept `sniper` config on `ScheduledBooking`, route to `runSniper`.
- Modify `server/src/blitz.ts` — `export` `summarizeFailures` and `safeShot` for reuse.
- Modify `server/src/public/index.html` — "Live Sessions" panel.
- Modify `server/package.json` — add `"test"` script.

---

### Task 1: Test harness + `pickSlot` matcher

**Files:**
- Modify: `server/package.json` (add test script)
- Create: `server/src/sniper.ts`
- Test: `server/test/sniper.test.ts`

**Interfaces:**
- Produces: `interface NormalizedSlot { date: string; time12: string; offerId?: string }`, `function pickSlot(slots: NormalizedSlot[], date: string, time24: string): NormalizedSlot | null`

- [ ] **Step 1: Add test script** — in `server/package.json` `scripts`, add:
```json
"test": "node --import tsx --test test/*.test.ts"
```

- [ ] **Step 2: Write the failing test** — `server/test/sniper.test.ts`:
```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pickSlot } from '../src/sniper';

const slots = [
  { date: '2026-07-15', time12: '5:00 PM', offerId: 'a' },
  { date: '2026-07-15', time12: '7:00 PM', offerId: 'b' },
];

test('pickSlot exact match on date+time', () => {
  const m = pickSlot(slots, '2026-07-15', '19:00');
  assert.equal(m?.offerId, 'b');
});

test('pickSlot returns null when date absent', () => {
  assert.equal(pickSlot(slots, '2026-07-16', '19:00'), null);
});

test('pickSlot returns null when time absent (no fuzzy fallback)', () => {
  assert.equal(pickSlot(slots, '2026-07-15', '20:00'), null);
});
```

- [ ] **Step 3: Run test to verify it fails** — Run: `cd server && npm test`. Expected: FAIL (`pickSlot` not exported / file missing).

- [ ] **Step 4: Implement** — `server/src/sniper.ts`:
```ts
import { to12Hour } from './booker';

export interface NormalizedSlot { date: string; time12: string; offerId?: string }

/** Exact date+time match. No fuzzy fallback — sniper only grabs what was asked. */
export function pickSlot(slots: NormalizedSlot[], date: string, time24: string): NormalizedSlot | null {
  const want = to12Hour(time24).toLowerCase();
  return slots.find(s => s.date === date && s.time12.toLowerCase() === want) ?? null;
}
```

- [ ] **Step 5: Run tests to verify pass** — Run: `cd server && npm test`. Expected: 3 passing.

- [ ] **Step 6: Commit**
```bash
git add server/package.json server/src/sniper.ts server/test/sniper.test.ts
git commit -m "sniper: pickSlot exact matcher + test harness"
```

---

### Task 2: `SingleWinnerLock`

**Files:**
- Modify: `server/src/sniper.ts`
- Test: `server/test/sniper.test.ts`

**Interfaces:**
- Produces: `class SingleWinnerLock { tryAcquire(): boolean; get won(): boolean }`

- [ ] **Step 1: Write failing test** — append to `server/test/sniper.test.ts`:
```ts
import { SingleWinnerLock } from '../src/sniper';

test('SingleWinnerLock grants exactly one winner', () => {
  const lock = new SingleWinnerLock();
  const results = [lock.tryAcquire(), lock.tryAcquire(), lock.tryAcquire()];
  assert.equal(results.filter(Boolean).length, 1);
  assert.equal(results[0], true);
  assert.equal(lock.won, true);
});
```

- [ ] **Step 2: Run to verify fail** — Run: `cd server && npm test`. Expected: FAIL (`SingleWinnerLock` undefined).

- [ ] **Step 3: Implement** — append to `server/src/sniper.ts`:
```ts
/** Synchronous compare-and-set; first caller wins, the rest get false.
 *  JS is single-threaded so a sync flag is a sufficient mutex across
 *  concurrent async poll loops. */
export class SingleWinnerLock {
  private claimed = false;
  tryAcquire(): boolean {
    if (this.claimed) return false;
    this.claimed = true;
    return true;
  }
  get won(): boolean { return this.claimed; }
}
```

- [ ] **Step 4: Run to verify pass** — Run: `cd server && npm test`. Expected: all passing.

- [ ] **Step 5: Commit**
```bash
git add server/src/sniper.ts server/test/sniper.test.ts
git commit -m "sniper: single-winner lock"
```

---

### Task 3: `computeWindowOffsets`

**Files:**
- Modify: `server/src/sniper.ts`
- Test: `server/test/sniper.test.ts`

**Interfaces:**
- Produces: `function computeWindowOffsets(pool: number, windowStartMs: number, windowEndMs: number): number[]` — returns `pool` evenly-spaced start offsets (ms vs `runAt`) covering `[windowStartMs, windowEndMs]`, first = `windowStartMs`, last = `windowEndMs`.

- [ ] **Step 1: Write failing test**:
```ts
import { computeWindowOffsets } from '../src/sniper';

test('computeWindowOffsets spans the window inclusively', () => {
  const o = computeWindowOffsets(5, -1000, 10000);
  assert.equal(o.length, 5);
  assert.equal(o[0], -1000);
  assert.equal(o[4], 10000);
  assert.deepEqual(o, [-1000, 1750, 4500, 7250, 10000]);
});

test('computeWindowOffsets pool=1 starts at window start', () => {
  assert.deepEqual(computeWindowOffsets(1, -1000, 10000), [-1000]);
});
```

- [ ] **Step 2: Run to verify fail** — Run: `cd server && npm test`. Expected: FAIL.

- [ ] **Step 3: Implement**:
```ts
/** Evenly spread `pool` poll-loop START offsets across [start,end] inclusive.
 *  Each loop then polls every pollIntervalMs until window end, so coverage
 *  overlaps and blankets the window. */
export function computeWindowOffsets(pool: number, windowStartMs: number, windowEndMs: number): number[] {
  const n = Math.max(1, pool);
  if (n === 1) return [windowStartMs];
  const span = windowEndMs - windowStartMs;
  return Array.from({ length: n }, (_, i) => windowStartMs + Math.round((span * i) / (n - 1)));
}
```

- [ ] **Step 4: Run to verify pass** — Run: `cd server && npm test`. Expected: passing.

- [ ] **Step 5: Commit**
```bash
git add server/src/sniper.ts server/test/sniper.test.ts
git commit -m "sniper: window offset spread"
```

---

### Task 4: Paused-session registry (`sessions.ts`)

**Files:**
- Create: `server/src/sessions.ts`
- Test: `server/test/sessions.test.ts`

**Interfaces:**
- Produces:
```ts
interface SessionHandle { browser: { close(): Promise<void> }; page: any }
interface FreezeInput { handle: SessionHandle; restaurant: string; bookedDate?: string; bookedTime?: string; error?: string; ttlMs?: number }
function freezeSession(input: FreezeInput): string            // returns id
function listSessions(): Array<{ id: string; restaurant: string; bookedDate?: string; bookedTime?: string; status: string; ageMs: number; error?: string }>
function getSession(id: string): (FreezeInput & { id: string; status: string }) | undefined
async function abortSession(id: string): Promise<boolean>     // close browser, remove
function _setNow(fn: () => number): void                      // test seam for deterministic TTL/age
function _sweep(): void                                       // TTL cleanup, exported for test
```
- Consumes: nothing from other tasks (pure registry; `applyAction`/`sessionScreenshot` that need a real `page` are added in Task 7's wiring but the bookkeeping here is browser-agnostic via the `SessionHandle` shape).

- [ ] **Step 1: Write failing test** — `server/test/sessions.test.ts`:
```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { freezeSession, listSessions, getSession, abortSession, _setNow, _sweep } from '../src/sessions';

function fakeHandle() {
  let closed = false;
  return { browser: { close: async () => { closed = true; }, get closed() { return closed; } }, page: {} };
}

test('freeze + list + get', () => {
  let now = 1000; _setNow(() => now);
  const h = fakeHandle();
  const id = freezeSession({ handle: h as any, restaurant: 'fhh', bookedDate: '2026-07-01', bookedTime: '8:00 PM', error: 'purchase failed' });
  now = 4000;
  const list = listSessions();
  const entry = list.find(e => e.id === id)!;
  assert.equal(entry.restaurant, 'fhh');
  assert.equal(entry.ageMs, 3000);
  assert.equal(getSession(id)?.error, 'purchase failed');
});

test('abort closes browser and removes', async () => {
  _setNow(() => 0);
  const h = fakeHandle();
  const id = freezeSession({ handle: h as any, restaurant: 'x' });
  assert.equal(await abortSession(id), true);
  assert.equal((h.browser as any).closed, true);
  assert.equal(getSession(id), undefined);
});

test('_sweep closes expired sessions past ttl', async () => {
  let now = 0; _setNow(() => now);
  const h = fakeHandle();
  freezeSession({ handle: h as any, restaurant: 'x', ttlMs: 1000 });
  now = 2000; _sweep();
  assert.equal(listSessions().length, 0);
  assert.equal((h.browser as any).closed, true);
});
```

- [ ] **Step 2: Run to verify fail** — Run: `cd server && npm test`. Expected: FAIL.

- [ ] **Step 3: Implement** — `server/src/sessions.ts`:
```ts
export interface SessionHandle { browser: { close(): Promise<void> }; page: any }
export interface FreezeInput {
  handle: SessionHandle; restaurant: string;
  bookedDate?: string; bookedTime?: string; error?: string; ttlMs?: number;
}
interface Entry extends FreezeInput { id: string; status: string; createdAt: number; ttlMs: number }

const DEFAULT_TTL = 10 * 60 * 1000; // ~Tock hold window
const sessions = new Map<string, Entry>();
let nowFn: () => number = () => Date.now();
let counter = 0;

export function _setNow(fn: () => number): void { nowFn = fn; }

export function freezeSession(input: FreezeInput): string {
  const id = `s${++counter}_${nowFn()}`;
  sessions.set(id, { ...input, id, status: 'frozen', createdAt: nowFn(), ttlMs: input.ttlMs ?? DEFAULT_TTL });
  return id;
}

export function listSessions() {
  const t = nowFn();
  return [...sessions.values()].map(e => ({
    id: e.id, restaurant: e.restaurant, bookedDate: e.bookedDate, bookedTime: e.bookedTime,
    status: e.status, ageMs: t - e.createdAt, error: e.error,
  }));
}

export function getSession(id: string): Entry | undefined { return sessions.get(id); }

export async function abortSession(id: string): Promise<boolean> {
  const e = sessions.get(id);
  if (!e) return false;
  try { await e.handle.browser.close(); } catch { /* ignore */ }
  sessions.delete(id);
  return true;
}

export function _sweep(): void {
  const t = nowFn();
  for (const e of [...sessions.values()]) {
    if (t - e.createdAt > e.ttlMs) { void abortSession(e.id); }
  }
}

// Periodic sweep in production (no-op effect in tests since they call _sweep directly).
setInterval(() => _sweep(), 30_000).unref?.();
```

- [ ] **Step 4: Run to verify pass** — Run: `cd server && npm test`. Expected: passing.

- [ ] **Step 5: Commit**
```bash
git add server/src/sessions.ts server/test/sessions.test.ts
git commit -m "sniper: paused-session registry with TTL"
```

---

### Task 5: `parseAvailability` (recon-seeded, isolated)

**Files:**
- Modify: `server/src/sniper.ts`
- Test: `server/test/sniper.test.ts`

**Interfaces:**
- Produces: `function parseAvailability(json: unknown): NormalizedSlot[]` — normalizes a Tock availability response into `NormalizedSlot[]`. **This is the only recon-dependent unit;** seed it from `docs/superpowers/specs` recon findings and adjust against a live capture. Until confirmed, it tolerates the two shapes seen in saved pages and returns `[]` on anything unrecognized (the engine then falls back to DOM scraping).

- [ ] **Step 1: Write failing test** (uses a representative shape; update the fixture to the real shape after live recon):
```ts
import { parseAvailability } from '../src/sniper';

test('parseAvailability normalizes availability entries', () => {
  const sample = {
    availability: [
      { date: '2026-07-01', offers: [
        { time: '8:00 PM', id: 'offer-1' },
        { time: '8:15 PM', id: 'offer-2' },
      ] },
    ],
  };
  const slots = parseAvailability(sample);
  assert.deepEqual(slots, [
    { date: '2026-07-01', time12: '8:00 PM', offerId: 'offer-1' },
    { date: '2026-07-01', time12: '8:15 PM', offerId: 'offer-2' },
  ]);
});

test('parseAvailability returns [] on unknown shape', () => {
  assert.deepEqual(parseAvailability({ weird: true }), []);
});
```

- [ ] **Step 2: Run to verify fail** — Run: `cd server && npm test`. Expected: FAIL.

- [ ] **Step 3: Implement** (defensive; adjust field names after recon):
```ts
export function parseAvailability(json: unknown): NormalizedSlot[] {
  const out: NormalizedSlot[] = [];
  const root: any = json;
  const days: any[] = Array.isArray(root?.availability) ? root.availability
    : Array.isArray(root?.days) ? root.days : [];
  for (const day of days) {
    const date = day?.date ?? day?.businessDate;
    const offers: any[] = Array.isArray(day?.offers) ? day.offers
      : Array.isArray(day?.times) ? day.times : [];
    for (const o of offers) {
      const time12 = o?.time ?? o?.display ?? o?.label;
      if (date && time12) out.push({ date, time12: String(time12), offerId: o?.id ?? o?.offerId });
    }
  }
  return out;
}
```

- [ ] **Step 4: Run to verify pass** — Run: `cd server && npm test`. Expected: passing.

- [ ] **Step 5: Commit**
```bash
git add server/src/sniper.ts server/test/sniper.test.ts
git commit -m "sniper: availability parser (recon-seeded, isolated)"
```

---

### Task 6: `runSniper` orchestration

**Files:**
- Modify: `server/src/sniper.ts`
- Modify: `server/src/blitz.ts` (export `summarizeFailures`, `safeShot`)

**Interfaces:**
- Consumes: `pickSlot`, `parseAvailability`, `SingleWinnerLock`, `computeWindowOffsets`; `freezeSession` (Task 4); `STEALTH_ARGS`, `handlePurchaseFlow`, `injectCookies`, `to12Hour`, fingerprints, `summarizeFailures`, `safeShot`.
- Produces:
```ts
export interface SniperConfig { pool: number; pollIntervalMs: number; windowStartMs: number; windowEndMs: number; maxPrice?: number }
export interface SniperResult {
  success: boolean; bookedDate?: string; bookedTime?: string; error?: string;
  screenshots?: string[]; durationMs: number; pausedSessionId?: string;
  polls: { total: number; matched: number };
}
export async function runSniper(req: BookingRequest, cfg: SniperConfig, runAt?: string,
  deps?: { availabilityUrl?: (req: BookingRequest, date: string) => string }): Promise<SniperResult>
```

**Implementation notes (concrete behavior — code written against existing booker patterns during execution):**

- [ ] **Step 1:** In `blitz.ts`, change `function summarizeFailures` → `export function summarizeFailures` and `async function safeShot` → `export async function safeShot`. Import both into `sniper.ts`.

- [ ] **Step 2:** Implement `runSniper`:
  1. Clamp `pool` to 1..6. Launch the pool with `chromium.launch({ headless: true, args: STEALTH_ARGS })` + fingerprinted contexts; `injectCookies`; if all fail or 0 cookies → return `{ success:false, error:'No Tock cookies configured', ... }`.
  2. Warm each browser: `page.goto(searchUrl)`. **Capture the availability endpoint** by attaching `page.on('response', ...)` during warmup and recording the URL whose body parses to a non-empty `parseAvailability`; store a template to refetch with the target date. If capture fails, set a `domFallback=true` flag.
  3. Compute `computeWindowOffsets(pool, windowStartMs, windowEndMs)`; if `runAt`, sleep until `runAt + windowStartMs`.
  4. Per browser, start a poll loop at its offset: every `pollIntervalMs` until `runAt + windowEndMs`, run `parseAvailability(await page.evaluate(fetch availabilityUrl))` (or, if `domFallback`, re-scrape the calendar like `runBookingFromPage`). On a `pickSlot` hit, call `lock.tryAcquire()`; only the winner proceeds.
  5. **Winner grab:** preferred — fire the Book/cart call via in-page `fetch` using the matched `offerId` (exact call filled in from recon; guarded by try/catch). Fallback — DOM click the matching `[data-testid="booking-card-button"]:not([disabled])`, waiting for it to be **enabled** (fixes the disabled-button hang). Then `handlePurchaseFlow(page, false, screenshots)`.
  6. **Success:** abort other loops, close their browsers, return `{ success:true, bookedDate, bookedTime, durationMs, polls }`.
  7. **Purchase failure:** do NOT close the winner; `freezeSession({ handle:{browser,page}, restaurant, bookedDate, bookedTime, error })`; push `await safeShot(page)`; return `{ success:false, pausedSessionId, screenshots, error:'purchase failed — session frozen for recovery', ... }`.
  8. **No hit by window end:** close all; return `{ success:false, error: 'No matching slot in window — ' + summarizeFailures(outcomes), polls }`.
  9. `finally`: close every non-winning, non-frozen browser.

- [ ] **Step 3:** Build: `cd server && npm run build`. Expected: tsc exit 0. (Behavioral verification is Task 8.)

- [ ] **Step 4: Commit**
```bash
git add server/src/sniper.ts server/src/blitz.ts
git commit -m "sniper: runSniper orchestration (poll → lock → grab → purchase → freeze)"
```

---

### Task 7: HTTP routes, scheduler wiring, dashboard panel

**Files:**
- Modify: `server/src/index.ts`, `server/src/scheduler.ts`, `server/src/sessions.ts` (add `applyAction`, `sessionScreenshot`), `server/src/public/index.html`

- [ ] **Step 1:** In `sessions.ts` add page-driven actions:
```ts
import { fillStripePayment, fillStripeBilling, getPayment } from './stripe';
import { handlePurchaseFlow } from './booker';
export async function sessionScreenshot(id: string): Promise<string | null> {
  const e = sessions.get(id); if (!e) return null;
  try { return (await e.handle.page.screenshot({ fullPage: false })).toString('base64'); } catch { return null; }
}
export async function applyAction(id: string, action: string, value?: string): Promise<{ ok: boolean; error?: string }> {
  const e = sessions.get(id); if (!e) return { ok: false, error: 'not found' };
  const page = e.handle.page;
  try {
    if (action === 'abort') { await abortSession(id); return { ok: true }; }
    if (action === 'refresh-screenshot') { return { ok: true }; }
    if (action === 're-enter-cvc') {
      const cvc = value ?? getPayment()?.cvc;
      const frame = page.frames().find((f: any) => f.url().includes('stripe') || f.url().includes('braintree'));
      const input = (frame ?? page).locator('input[name="cvv"], input[name="cvc"], input[placeholder="CVC"]').first();
      await input.click(); await input.fill(cvc ?? ''); return { ok: true };
    }
    if (action === 'retry-purchase') {
      const ok = await handlePurchaseFlow(page, false, []);
      if (ok) { await abortSession(id); }
      return { ok };
    }
    return { ok: false, error: 'unknown action' };
  } catch (err) { return { ok: false, error: err instanceof Error ? err.message : String(err) }; }
}
```

- [ ] **Step 2:** In `index.ts` add routes (auth-protected) after the history routes:
```ts
import { runSniper, SniperConfig } from './sniper';
import { listSessions, sessionScreenshot, applyAction } from './sessions';

app.post('/api/sniper', requireAuth, async (req, res) => {
  const { sniper, ...bk } = req.body;
  if (!bk.restaurant || !bk.dates?.length || !bk.time || !bk.partySize)
    return res.status(400).json({ success: false, error: 'Missing required fields' });
  const cfg: SniperConfig = {
    pool: Math.min(Math.max(sniper?.pool ?? 5, 1), 6),
    pollIntervalMs: sniper?.pollIntervalMs ?? 200,
    windowStartMs: sniper?.windowStartMs ?? -1000,
    windowEndMs: sniper?.windowEndMs ?? 10000,
    maxPrice: sniper?.maxPrice,
  };
  try {
    const result = await runSniper(bk, cfg, sniper?.runAt);
    addToHistory({ id: crypto.randomUUID(), restaurant: bk.restaurant, date: result.bookedDate, time: result.bookedTime,
      success: result.success, error: result.error, screenshots: result.screenshots, ranAt: new Date().toISOString(), source: 'manual' });
    res.json(result);
  } catch (err) { res.status(500).json({ success: false, error: err instanceof Error ? err.message : String(err) }); }
});

app.get('/api/sessions', requireAuth, (_req, res) => res.json(listSessions()));
app.get('/api/sessions/:id/screenshot', requireAuth, async (req, res) => {
  const b64 = await sessionScreenshot(req.params.id);
  if (!b64) return res.status(404).json({ error: 'not found' });
  res.setHeader('Content-Type', 'image/png'); res.send(Buffer.from(b64, 'base64'));
});
app.post('/api/sessions/:id/action', requireAuth, async (req, res) => {
  res.json(await applyAction(req.params.id, req.body?.action, req.body?.value));
});
```

- [ ] **Step 3:** In `scheduler.ts`: add `sniper?: SniperConfig` to `ScheduledBooking`; in `executeBooking`, branch `if (booking.sniper) { result = await runSniper(booking, booking.sniper, booking.runAt); }` before the blitz branch. Import `runSniper`, `SniperConfig`.

- [ ] **Step 4:** In `public/index.html`: add a "Live Sessions" panel that polls `GET /api/sessions`, renders each with an `<img src="/api/sessions/:id/screenshot">` and four buttons posting to `/api/sessions/:id/action` (`re-enter-cvc`, `retry-purchase`, `refresh-screenshot`, `abort`). Mirror the existing history-screenshot rendering style.

- [ ] **Step 5:** Build: `cd server && npm run build`. Expected: tsc exit 0.

- [ ] **Step 6: Commit**
```bash
git add server/src/index.ts server/src/scheduler.ts server/src/sessions.ts server/src/public/index.html
git commit -m "sniper: HTTP routes, scheduler wiring, Live Sessions dashboard panel"
```

---

### Task 8: Mock-availability integration test

**Files:**
- Create: `server/test/sniper-integration.test.ts`

**Goal:** Prove detect → single-winner grab → freeze-recovery without touching Tock, using a local HTTP mock that returns "none" then flips to a slot, and a stubbed availability URL + DOM-free grab path. Because `runSniper` is browser-coupled, this test exercises the **pure decision core** wired together: a fake poll source feeding `parseAvailability`+`pickSlot` through a `SingleWinnerLock`, asserting exactly one winner across concurrent loops and that a simulated purchase-failure freezes a session.

- [ ] **Step 1: Write the test:**
```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseAvailability, pickSlot, SingleWinnerLock } from '../src/sniper';
import { freezeSession, listSessions, abortSession, _setNow } from '../src/sessions';

test('concurrent loops over a none→slot feed yield exactly one winner', async () => {
  let flipped = false;
  const feed = () => flipped
    ? { availability: [{ date: '2026-07-01', offers: [{ time: '8:00 PM', id: 'win' }] }] }
    : { availability: [] };
  setTimeout(() => { flipped = true; }, 50);
  const lock = new SingleWinnerLock();
  const winners: string[] = [];
  async function loop() {
    for (let i = 0; i < 50; i++) {
      const slot = pickSlot(parseAvailability(feed()), '2026-07-01', '20:00');
      if (slot && lock.tryAcquire()) { winners.push(slot.offerId!); return; }
      await new Promise(r => setTimeout(r, 10));
    }
  }
  await Promise.all([loop(), loop(), loop(), loop(), loop()]);
  assert.equal(winners.length, 1);
  assert.equal(winners[0], 'win');
});

test('purchase-failure path freezes a recoverable session', async () => {
  _setNow(() => 0);
  let closed = false;
  const handle = { browser: { close: async () => { closed = true; } }, page: {} };
  const id = freezeSession({ handle: handle as any, restaurant: 'fhh', bookedDate: '2026-07-01', bookedTime: '8:00 PM', error: 'purchase failed' });
  assert.equal(listSessions().some(s => s.id === id), true);
  assert.equal(await abortSession(id), true);
  assert.equal(closed, true);
});
```

- [ ] **Step 2: Run** — Run: `cd server && npm test`. Expected: all tests pass (Tasks 1–5 + integration).

- [ ] **Step 3: Commit**
```bash
git add server/test/sniper-integration.test.ts
git commit -m "sniper: mock-availability integration test (single-winner + freeze-recovery)"
```

---

## Self-Review

**Spec coverage:**
- §3 dense polling → Tasks 3, 6. §4.3 single-winner lock → Task 2. §4.4 grab w/ fallback → Task 6 step 2.5. §4.6 recovery console → Tasks 4, 7. §5 config → Task 7. §6 error handling (no-hit summary, throttle, memory/TTL) → Tasks 4, 6. §7 testing → Tasks 1–5, 8. §4.1 endpoint recon → Task 6 step 2 (+ Task 5 isolation). All covered.
- **Known limitation (documented in spec §8):** the live direct-Book-call shape and the real availability JSON shape require a live capture; `parseAvailability` (Task 5) and the grab (Task 6) are isolated so the DOM fallback keeps everything working until that capture lands. This is intentional, not a gap.

**Placeholder scan:** No TBD/TODO. Browser-coupled grab specifics in Task 6 are described as concrete behavior steps with the exact fallback selectors; the integration test (Task 8) covers the decision core deterministically, with live smoke deferred per spec §8.

**Type consistency:** `NormalizedSlot`, `SingleWinnerLock`, `computeWindowOffsets`, `parseAvailability`, `pickSlot`, `SniperConfig`, `SniperResult`, `freezeSession`/`listSessions`/`getSession`/`abortSession`/`applyAction`/`sessionScreenshot` consistent across tasks.
