# OpenTable Reservation Grabber Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an OpenTable booking engine to the existing Tock grabber — same Railway server, dashboard, scheduler, history, and safety model — plus finish the Chrome extension's in-browser OpenTable checkout, including Stripe payment for card/deposit restaurants.

**Architecture:** Add a `platform` field (default `'tock'`) to the booking request and a thin dispatcher (`engines.ts`) that routes to the existing Tock engine or a new `server/src/opentable/` engine. The Tock engine files are left untouched (they are battle-tested against Cloudflare + protobuf); OpenTable is additive. The engine drives OpenTable's DOM in a real (cookied) Playwright browser — because OpenTable blocks cookieless automation with "Access Denied" — reusing the fail-closed Amount-due price cap and `sessions.ts` freeze-for-recovery. The extension gains an OpenTable URL builder, drop-timing wiring, and checkout continuation.

**Tech Stack:** Node/TypeScript, Express, Playwright 1.52, Chrome MV3 extension (webpack), AppleScript/`cliclick` card helper. Server uses `tsc`; extension uses `npm run build`. Tests via Node's built-in `node:test` + `node:assert` (matches existing server test style — see `server/src/*.test.ts` if present; otherwise add a `test` script).

## Global Constraints

- **Back-compat is mandatory:** `platform` defaults to `'tock'` everywhere. No existing Tock booking, schedule, cookie jar, dashboard behavior, or unit test may change behavior.
- **Fail-closed payment:** never click a final "Complete reservation" / purchase button when the total is missing/unparseable or exceeds the configured cap. A missing price is treated as "too expensive."
- **Auth model:** OpenTable session comes from **pushed cookies** only. No OpenTable auto-login in this build (reCAPTCHA).
- **Phase boundary:** No OpenTable *sniper* (`/api/sniper` rejects `platform: 'opentable'`). GraphQL fast-poll/API-grab is Phase 2, out of scope.
- **OpenTable identity:** operator field `restaurant` accepts an OpenTable slug (e.g. `nopa-san-francisco1`) or a full `opentable.com/r/...` URL. Search URL shape: `https://www.opentable.com/r/{slug}?datetime={YYYY-MM-DD}T{HH:MM}&covers={party}`.
- **Node for tests:** run server tests with Node 20 (`nvm use 20` — repo `.nvmrc`). Playwright 1.52 requires Node ≥18.
- **Recon dependency:** Tasks 10–12 require the user's OpenTable cookies + one target restaurant. Tasks 1–9 need neither and are built/tested first.

---

## File Structure

**Server — new files (`server/src/`):**
- `opentable/url.ts` — build/parse OpenTable search URLs + slug extraction.
- `opentable/url.test.ts` — unit tests.
- `opentable/availability.ts` — pure slot parsing + best-slot selection from OpenTable DOM data.
- `opentable/availability.test.ts` — unit tests against the `opentable-nopa.html` fixture data.
- `opentable/selectors.ts` — typed OpenTable selector constants (profile known now; checkout section filled by the Task 10 recon).
- `opentable/booker.ts` — `runOpenTableBooking`, `runOpenTableBookingWithContext`, `handleOpenTableCheckout`.
- `opentable/blitz.ts` — `runOpenTableBlitz`.
- `opentable/checkout.ts` — OpenTable Stripe fill + Amount-due parse.
- `opentable/checkout.test.ts` — unit tests for the price-cap parser.
- `engines.ts` — `getBookingEngine(platform)` dispatcher.

**Server — modified files:**
- `cookies.ts` — generalize to per-platform jars.
- `booker.ts` — export `parseAmountDueCents`, `STEALTH_ARGS`, `randomDelay`, `to12Hour` for reuse (verify they're exported; add if not).
- `scheduler.ts` — dispatch `executeBooking` by `booking.platform`; reject OpenTable+sniper.
- `index.ts` — `platform` on booking routes; per-platform cookie routes; reject OpenTable sniper.
- `store.ts` — add `opentableCookies` key to `StoreData`.
- `public/index.html` — platform selector + OpenTable bookmarklet + per-platform cookie status.
- `blitz.ts` — export `getFingerprint`, `summarizeFailures`, `safeShot` (verify/add) for reuse.

**Extension — modified files (`src/`):**
- `utils/url-builder.ts` — add OpenTable builders.
- `utils/url-builder.test.ts` — unit tests (create if absent).
- `background/index.ts` — OpenTable pre-nav + drop-refresh + multi-date.
- `content/index.ts` — allow OpenTable in multi-date path.
- `content/opentable-form-filler.ts` — checkout continuation.
- `scripts/cvc-server.js` — `buildOpenTableStripeFillerScript`.

**Docs:**
- `docs/ARCHITECTURE.md` — add OpenTable engine section.
- `README.md` — OpenTable operation notes.

---

## Task 1: `platform` field + per-platform cookie jars

**Files:**
- Modify: `server/src/booker.ts` (add `platform` to `BookingRequest`)
- Modify: `server/src/store.ts` (`StoreData.opentableCookies`)
- Modify: `server/src/cookies.ts`
- Test: `server/src/cookies.test.ts` (create)

**Interfaces:**
- Consumes: existing `TockCookie`, `saveToDisk`/`loadFromDisk`.
- Produces:
  - `type Platform = 'tock' | 'opentable'` (add to `booker.ts`, re-export).
  - `BookingRequest.platform?: Platform`.
  - `getCookies(platform?: Platform): TockCookie[]` (default `'tock'`).
  - `updateCookies(cookies: TockCookie[], platform?: Platform): void`.
  - `injectCookies(context, platform?: Platform): Promise<number>` (OpenTable default domain `.opentable.com`).
  - `loadCookiesFromEnv()` also reads `OPENTABLE_COOKIES`.

- [ ] **Step 1: Write the failing test**

```ts
// server/src/cookies.test.ts
import { test } from 'node:test';
import assert from 'node:assert';
import { updateCookies, getCookies } from './cookies';

test('cookies are stored per platform and do not cross-contaminate', () => {
  updateCookies([{ name: 't', value: '1', domain: '.exploretock.com', path: '/' }], 'tock');
  updateCookies([{ name: 'o', value: '2', domain: '.opentable.com', path: '/' }], 'opentable');
  assert.equal(getCookies('tock').length, 1);
  assert.equal(getCookies('tock')[0].name, 't');
  assert.equal(getCookies('opentable').length, 1);
  assert.equal(getCookies('opentable')[0].name, 'o');
});

test('getCookies defaults to tock (back-compat)', () => {
  updateCookies([{ name: 't', value: '1', domain: '.exploretock.com', path: '/' }]);
  assert.equal(getCookies().length, 1);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && nvm use 20 && npx tsx --test src/cookies.test.ts`
Expected: FAIL (updateCookies/getCookies don't accept a platform arg).

- [ ] **Step 3: Implement per-platform jars in `cookies.ts`**

Replace the single-jar module state with a per-platform map. New content of `cookies.ts`:

```ts
import { BrowserContext } from 'playwright';
import { saveToDisk, loadFromDisk } from './store';

export type Platform = 'tock' | 'opentable';

export interface TockCookie {
  name: string; value: string; domain: string; path: string;
  httpOnly?: boolean; secure?: boolean; sameSite?: 'Strict' | 'Lax' | 'None'; expires?: number;
}

const DISK_KEY: Record<Platform, string> = { tock: 'cookies', opentable: 'opentableCookies' };
const ENV_VAR: Record<Platform, string> = { tock: 'TOCK_COOKIES', opentable: 'OPENTABLE_COOKIES' };
const DEFAULT_DOMAIN: Record<Platform, string> = { tock: '.exploretock.com', opentable: '.opentable.com' };

const jars: Record<Platform, TockCookie[]> = { tock: [], opentable: [] };

export function loadCookiesFromEnv(): void {
  (['tock', 'opentable'] as Platform[]).forEach((p) => {
    const fromDisk = loadFromDisk(DISK_KEY[p]);
    if (Array.isArray(fromDisk) && fromDisk.length > 0) {
      jars[p] = fromDisk;
      console.log(`🍪 Loaded ${jars[p].length} ${p} cookies from disk`);
      return;
    }
    const raw = process.env[ENV_VAR[p]];
    if (!raw) return;
    try {
      jars[p] = JSON.parse(Buffer.from(raw, 'base64').toString('utf-8'));
      saveToDisk(DISK_KEY[p], jars[p]);
    } catch (err) {
      console.error(`Failed to parse ${ENV_VAR[p]}:`, err);
    }
  });
}

export function updateCookies(cookies: TockCookie[], platform: Platform = 'tock'): void {
  jars[platform] = cookies;
  saveToDisk(DISK_KEY[platform], cookies);
}

export function getCookies(platform: Platform = 'tock'): TockCookie[] {
  return jars[platform];
}

export async function injectCookies(context: BrowserContext, platform: Platform = 'tock'): Promise<number> {
  const stored = jars[platform];
  if (stored.length === 0) return 0;
  const playwrightCookies = stored.map((c) => ({
    name: c.name, value: c.value,
    domain: c.domain || DEFAULT_DOMAIN[platform], path: c.path || '/',
    httpOnly: c.httpOnly ?? false, secure: c.secure ?? true,
    sameSite: (c.sameSite as 'Strict' | 'Lax' | 'None') || 'Lax',
    expires: c.expires || Math.floor(Date.now() / 1000) + 86400,
  }));
  await context.addCookies(playwrightCookies);
  return playwrightCookies.length;
}
```

Add to `store.ts` `StoreData`: `opentableCookies?: any[];`. Add `platform?: Platform` to `BookingRequest` in `booker.ts` and `import type { Platform } from './cookies'` (or define there and have cookies import — pick booker.ts as the owner to avoid a cycle: define `Platform` in `booker.ts`, and in `cookies.ts` `import type { Platform } from './booker'`). **Owner decision: define `Platform` in `cookies.ts`** (as above) since cookies is lower-level; `booker.ts` imports it.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd server && npx tsx --test src/cookies.test.ts`
Expected: PASS (both tests).

- [ ] **Step 5: Verify existing Tock callers still compile**

Run: `cd server && npx tsc --noEmit`
Expected: no errors (all existing `getCookies()`/`injectCookies(ctx)`/`updateCookies(x)` calls use defaults).

- [ ] **Step 6: Commit**

```bash
git add server/src/cookies.ts server/src/cookies.test.ts server/src/store.ts server/src/booker.ts
git commit -m "feat(server): per-platform cookie jars + platform field on BookingRequest"
```

---

## Task 2: OpenTable URL builder (server)

**Files:**
- Create: `server/src/opentable/url.ts`
- Test: `server/src/opentable/url.test.ts`

**Interfaces:**
- Produces:
  - `extractOpenTableSlug(input: string): string` — slug from a slug or full URL.
  - `buildOpenTableSearchUrl(restaurant: string, date: string, time: string, partySize: number): string`.

- [ ] **Step 1: Write the failing test**

```ts
// server/src/opentable/url.test.ts
import { test } from 'node:test';
import assert from 'node:assert';
import { extractOpenTableSlug, buildOpenTableSearchUrl } from './url';

test('extractOpenTableSlug handles slug and full URL', () => {
  assert.equal(extractOpenTableSlug('nopa-san-francisco1'), 'nopa-san-francisco1');
  assert.equal(extractOpenTableSlug('https://www.opentable.com/r/nopa-san-francisco1'), 'nopa-san-francisco1');
  assert.equal(extractOpenTableSlug('https://www.opentable.com/r/nopa-san-francisco1?x=1'), 'nopa-san-francisco1');
});

test('buildOpenTableSearchUrl encodes datetime + covers', () => {
  const u = buildOpenTableSearchUrl('nopa-san-francisco1', '2026-07-19', '19:00', 2);
  assert.match(u, /^https:\/\/www\.opentable\.com\/r\/nopa-san-francisco1\?/);
  assert.match(u, /datetime=2026-07-19T19%3A00/);
  assert.match(u, /covers=2/);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && npx tsx --test src/opentable/url.test.ts`
Expected: FAIL ("Cannot find module './url'").

- [ ] **Step 3: Implement `url.ts`**

```ts
// server/src/opentable/url.ts
/** Extract the OpenTable restaurant slug from a bare slug or a full opentable.com URL. */
export function extractOpenTableSlug(input: string): string {
  const trimmed = input.trim();
  const m = trimmed.match(/opentable\.[a-z.]+\/r\/([^/?#]+)/i);
  if (m) return m[1];
  // Bare slug: strip any leading slash / query.
  return trimmed.replace(/^\/+/, '').split(/[?#]/)[0];
}

/** Build the OpenTable search/profile URL for a date/time/party. */
export function buildOpenTableSearchUrl(restaurant: string, date: string, time: string, partySize: number): string {
  const slug = extractOpenTableSlug(restaurant);
  const datetime = encodeURIComponent(`${date}T${time}`);
  return `https://www.opentable.com/r/${slug}?datetime=${datetime}&covers=${partySize}`;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd server && npx tsx --test src/opentable/url.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/src/opentable/url.ts server/src/opentable/url.test.ts
git commit -m "feat(server): OpenTable search-URL builder + slug extraction"
```

---

## Task 3: OpenTable availability parser (pure, fixture-tested)

**Files:**
- Create: `server/src/opentable/availability.ts`
- Test: `server/src/opentable/availability.test.ts`

**Interfaces:**
- Consumes: `to12Hour` from `booker.ts`.
- Produces:
  - `interface OpenTableSlot { time24: string; time12: string; testid: string; }`
  - `parseSlots(raw: {testid: string; text: string}[]): OpenTableSlot[]` — parse `"6:00 PM*"` → `time24='18:00'`.
  - `pickBestSlot(slots: OpenTableSlot[], preferred24: string): OpenTableSlot | null` — exact, else closest by minutes.

- [ ] **Step 1: Write the failing test**

```ts
// server/src/opentable/availability.test.ts
import { test } from 'node:test';
import assert from 'node:assert';
import { parseSlots, pickBestSlot } from './availability';

const RAW = [
  { testid: 'time-slot-0', text: '5:30 PM' },
  { testid: 'time-slot-1', text: '6:00 PM*' },   // '*' = requires card / special
  { testid: 'time-slot-2', text: '7:15 PM' },
];

test('parseSlots normalizes 12h text to 24h and strips markers', () => {
  const slots = parseSlots(RAW);
  assert.equal(slots.length, 3);
  assert.deepEqual(slots.map(s => s.time24), ['17:30', '18:00', '19:15']);
});

test('pickBestSlot returns exact match', () => {
  const slots = parseSlots(RAW);
  assert.equal(pickBestSlot(slots, '18:00')?.testid, 'time-slot-1');
});

test('pickBestSlot returns closest when no exact match', () => {
  const slots = parseSlots(RAW);
  assert.equal(pickBestSlot(slots, '19:00')?.testid, 'time-slot-2'); // 19:15 is closest
});

test('pickBestSlot returns null for empty', () => {
  assert.equal(pickBestSlot([], '19:00'), null);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && npx tsx --test src/opentable/availability.test.ts`
Expected: FAIL ("Cannot find module './availability'").

- [ ] **Step 3: Implement `availability.ts`**

```ts
// server/src/opentable/availability.ts
export interface OpenTableSlot { time24: string; time12: string; testid: string; }

/** Parse OpenTable slot button text like "6:00 PM*" into a normalized slot. */
export function parseSlots(raw: { testid: string; text: string }[]): OpenTableSlot[] {
  const out: OpenTableSlot[] = [];
  for (const { testid, text } of raw) {
    const m = (text || '').match(/(\d{1,2}):(\d{2})\s*(AM|PM)/i);
    if (!m) continue;
    let h = parseInt(m[1], 10);
    const min = parseInt(m[2], 10);
    const period = m[3].toUpperCase();
    if (period === 'PM' && h !== 12) h += 12;
    if (period === 'AM' && h === 12) h = 0;
    const time24 = `${String(h).padStart(2, '0')}:${String(min).padStart(2, '0')}`;
    out.push({ time24, time12: `${m[1]}:${m[2]} ${period}`, testid });
  }
  return out;
}

function toMinutes(t24: string): number {
  const [h, m] = t24.split(':').map(Number);
  return h * 60 + m;
}

/** Exact match on preferred 24h time, else the slot closest in minutes. */
export function pickBestSlot(slots: OpenTableSlot[], preferred24: string): OpenTableSlot | null {
  if (slots.length === 0) return null;
  const exact = slots.find((s) => s.time24 === preferred24);
  if (exact) return exact;
  const target = toMinutes(preferred24);
  return slots.reduce((best, s) =>
    Math.abs(toMinutes(s.time24) - target) < Math.abs(toMinutes(best.time24) - target) ? s : best
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd server && npx tsx --test src/opentable/availability.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Add a fixture-parity test using the real capture**

Add to `availability.test.ts` — confirms our slot regex matches the real DOM text shape in the saved capture:

```ts
import { readFileSync } from 'node:fs';
import path from 'node:path';

test('regex matches real slot text found in opentable-nopa.html', () => {
  const html = readFileSync(path.join(__dirname, '../../../opentable-nopa.html'), 'utf-8');
  // Real OpenTable slot labels look like "6:00 PM" / "6:00 PM*"; assert at least one is present
  // and parses. (The capture is a profile page snapshot.)
  const matches = html.match(/\d{1,2}:\d{2}\s*(AM|PM)/gi) || [];
  assert.ok(matches.length > 0, 'expected at least one time label in the capture');
  const parsed = parseSlots(matches.slice(0, 5).map((t, i) => ({ testid: `time-slot-${i}`, text: t })));
  assert.ok(parsed.length > 0);
});
```

Run: `cd server && npx tsx --test src/opentable/availability.test.ts`
Expected: PASS (5 tests). If the fixture path differs, adjust the relative path to reach repo-root `opentable-nopa.html`.

- [ ] **Step 6: Commit**

```bash
git add server/src/opentable/availability.ts server/src/opentable/availability.test.ts
git commit -m "feat(server): OpenTable slot parser + best-slot selection (fixture-tested)"
```

---

## Task 4: OpenTable selectors module

**Files:**
- Create: `server/src/opentable/selectors.ts`

**Interfaces:**
- Produces: `OT_SELECTORS` constant with a `profile` section (known now) and a `checkout` section (filled by the Task 10 recon). Booker/checkout code imports named fields so their code is complete regardless of when values land.

- [ ] **Step 1: Create `selectors.ts` with verified profile selectors**

```ts
// server/src/opentable/selectors.ts
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
```

- [ ] **Step 2: Verify it compiles**

Run: `cd server && npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add server/src/opentable/selectors.ts
git commit -m "feat(server): OpenTable selector registry (profile verified, checkout pending recon)"
```

---

## Task 5: OpenTable booker — search → slot hold

**Files:**
- Create: `server/src/opentable/booker.ts`
- Modify: `server/src/booker.ts` (ensure `STEALTH_ARGS`, `randomDelay`, `to12Hour` are exported — they are per ARCHITECTURE.md; add `export` if any is not)

**Interfaces:**
- Consumes: `injectCookies` (Task 1), `buildOpenTableSearchUrl` (Task 2), `parseSlots`/`pickBestSlot` (Task 3), `OT_SELECTORS` (Task 4), `BookingRequest`/`BookingResult`/`STEALTH_ARGS`/`randomDelay` from `booker.ts`.
- Produces:
  - `runOpenTableBookingWithContext(context: BrowserContext, req: BookingRequest, signal?: AbortSignal): Promise<BookingResult>` — up to slot held; calls `handleOpenTableCheckout` (Task 10) which for now is a stub that returns `{ heldOnly: true }` when `autoPurchase !== false`.
  - `runOpenTableBooking(req: BookingRequest): Promise<BookingResult>` — launch → inject → book → close.

- [ ] **Step 1: Implement `opentable/booker.ts` (search → select date → click slot)**

```ts
// server/src/opentable/booker.ts
import { chromium, Browser, BrowserContext, Page } from 'playwright';
import { BookingRequest, BookingResult, STEALTH_ARGS, randomDelay } from '../booker';
import { injectCookies } from '../cookies';
import { buildOpenTableSearchUrl } from './url';
import { parseSlots, pickBestSlot } from './availability';
import { OT_SELECTORS } from './selectors';

async function readSlots(page: Page): Promise<{ testid: string; text: string }[]> {
  return page.$$eval(OT_SELECTORS.profile.timeSlot, (els) =>
    els.map((el) => ({
      testid: el.getAttribute('data-testid') || '',
      text: (el.querySelector('[role="button"]')?.textContent || el.textContent || '').trim(),
    }))
  );
}

export async function runOpenTableBookingWithContext(
  context: BrowserContext, req: BookingRequest, signal?: AbortSignal
): Promise<BookingResult> {
  const screenshots: string[] = [];
  try {
    const page = await context.newPage();
    await page.addInitScript(() => {
      Object.defineProperty((globalThis as any).navigator, 'webdriver', { get: () => false });
    });

    const url = buildOpenTableSearchUrl(req.restaurant, req.dates[0], req.time, req.partySize);
    console.log(`📍 [OT] Navigating: ${url}`);
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(randomDelay(800, 1500));
    if (signal?.aborted) return { success: false, error: 'Aborted', screenshots };

    // Guard: OpenTable "Access Denied" means we have no valid session cookies.
    if ((await page.title()).includes('Access Denied')) {
      return { success: false, error: 'OpenTable Access Denied — push a fresh OpenTable session (cookies missing/expired).', screenshots };
    }

    // Wait for slots to render.
    try {
      await page.waitForSelector(OT_SELECTORS.profile.timeSlot, { timeout: 15000 });
    } catch {
      return { success: false, error: 'No time slots rendered (sold out, wrong date, or selector drift).', screenshots };
    }

    const slots = parseSlots(await readSlots(page));
    const best = pickBestSlot(slots, req.time);
    if (!best) return { success: false, error: `No slots on ${req.dates[0]}. Seen: ${slots.map(s => s.time12).join(', ') || 'none'}`, screenshots };

    console.log(`🎯 [OT] Clicking slot ${best.time12} (${best.testid})`);
    await page.locator(`[data-testid="${best.testid}"] [role="button"], [data-testid="${best.testid}"]`).first().click();
    await page.waitForTimeout(randomDelay(1500, 3000));
    if (signal?.aborted) return { success: false, bookedDate: req.dates[0], bookedTime: best.time12, error: 'Aborted after slot click', screenshots };

    if (req.autoPurchase === false) {
      return { success: true, bookedDate: req.dates[0], bookedTime: best.time12, screenshots };
    }

    // Checkout completion is Task 10; until then, report held-only (fail-closed: no purchase).
    const { handleOpenTableCheckout } = await import('./checkout');
    const done = await handleOpenTableCheckout(page, req, screenshots);
    return done.success
      ? { success: true, bookedDate: req.dates[0], bookedTime: best.time12, screenshots }
      : { success: false, bookedDate: req.dates[0], bookedTime: best.time12, error: done.error, screenshots };
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : String(err), screenshots };
  }
}

export async function runOpenTableBooking(req: BookingRequest): Promise<BookingResult> {
  let browser: Browser | null = null;
  try {
    browser = await chromium.launch({ headless: true, channel: 'chromium', args: STEALTH_ARGS });
    const context = await browser.newContext({
      viewport: { width: 1440, height: 900 },
      userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
      locale: 'en-US', timezoneId: 'America/Los_Angeles',
    });
    const n = await injectCookies(context, 'opentable');
    if (n === 0) return { success: false, error: 'No OpenTable cookies configured. Push a session first.' };
    return await runOpenTableBookingWithContext(context, req);
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : String(err) };
  } finally {
    if (browser) await browser.close();
  }
}
```

- [ ] **Step 2: Create a minimal `checkout.ts` stub (real impl in Task 10)**

```ts
// server/src/opentable/checkout.ts
import { Page } from 'playwright';
import { BookingRequest } from '../booker';

export interface CheckoutOutcome { success: boolean; error?: string; heldOnly?: boolean; }

/** STUB until Task 10 recon. Fail-closed: holds the slot but does not purchase. */
export async function handleOpenTableCheckout(_page: Page, _req: BookingRequest, screenshots: string[]): Promise<CheckoutOutcome> {
  try { screenshots.push((await _page.screenshot({ fullPage: false })).toString('base64')); } catch { /* best effort */ }
  return { success: false, heldOnly: true, error: 'Checkout not yet implemented (Task 10) — slot reached, not purchased.' };
}
```

- [ ] **Step 3: Verify compile + existing tests green**

Run: `cd server && npx tsc --noEmit && npx tsx --test src/opentable/*.test.ts`
Expected: no type errors; Task 2/3 tests still PASS.

- [ ] **Step 4: Commit**

```bash
git add server/src/opentable/booker.ts server/src/opentable/checkout.ts
git commit -m "feat(server): OpenTable booker (search -> slot hold); checkout stub fail-closed"
```

---

## Task 6: Engine dispatcher + route `/api/book` by platform

**Files:**
- Create: `server/src/engines.ts`
- Modify: `server/src/index.ts` (`/api/book`, legacy `/book`)

**Interfaces:**
- Consumes: `runBooking` (Tock), `runOpenTableBooking`.
- Produces: `getBookingEngine(platform?: Platform): { runBooking: (req: BookingRequest) => Promise<BookingResult> }`.

- [ ] **Step 1: Implement `engines.ts`**

```ts
// server/src/engines.ts
import { runBooking as runTockBooking, BookingRequest, BookingResult } from './booker';
import { runOpenTableBooking } from './opentable/booker';
import type { Platform } from './cookies';

export function getBookingEngine(platform: Platform = 'tock'): {
  runBooking: (req: BookingRequest) => Promise<BookingResult>;
} {
  if (platform === 'opentable') return { runBooking: runOpenTableBooking };
  return { runBooking: runTockBooking };
}
```

- [ ] **Step 2: Route `/api/book` and `/book` by platform**

In `index.ts`, change both handlers to resolve the engine. Example for `/api/book` (apply the same to `/book`):

```ts
import { getBookingEngine } from './engines';
// ...
app.post('/api/book', requireAuth, async (req, res) => {
  const { restaurant, dates, partySize, time, autoPurchase, dryRun, platform } = req.body as BookingRequest;
  if (!restaurant || !dates?.length || !partySize || !time) {
    res.status(400).json({ error: 'Missing required fields: restaurant, dates, partySize, time' });
    return;
  }
  const engine = getBookingEngine(platform);
  const result = await engine.runBooking({ restaurant, dates, partySize, time, autoPurchase, dryRun, platform });
  await notifyResult(restaurant, result);
  addToHistory({ id: crypto.randomUUID(), restaurant, date: result.bookedDate, time: result.bookedTime,
    success: result.success, error: result.error, screenshots: result.screenshots,
    ranAt: new Date().toISOString(), source: 'manual' });
  res.json(result);
});
```

- [ ] **Step 3: Manual smoke — OpenTable path returns the no-cookies error (no cookies loaded locally)**

Run:
```bash
cd server && npx tsx src/index.ts &   # starts on :3000 (API_KEY unset = open)
sleep 2
curl -s -XPOST localhost:3000/api/book -H 'content-type: application/json' \
  -d '{"platform":"opentable","restaurant":"nopa-san-francisco1","dates":["2026-07-19"],"partySize":2,"time":"19:00","dryRun":true}'
kill %1
```
Expected: JSON `{"success":false,"error":"No OpenTable cookies configured. Push a session first."}` — proves dispatch + fail-closed wiring without needing real cookies.

- [ ] **Step 4: Verify Tock path unchanged**

Run: `curl` the same without `platform` → routes to Tock `runBooking` (will fail on no Tock cookies too, but via the Tock code path). Confirm no regression in `npx tsc --noEmit`.

- [ ] **Step 5: Commit**

```bash
git add server/src/engines.ts server/src/index.ts
git commit -m "feat(server): engine dispatcher; /api/book routes by platform"
```

---

## Task 7: OpenTable blitz + scheduler dispatch + reject OpenTable sniper

**Files:**
- Create: `server/src/opentable/blitz.ts`
- Modify: `server/src/engines.ts` (add `runBlitz`)
- Modify: `server/src/scheduler.ts` (dispatch by platform; reject OpenTable+sniper)
- Modify: `server/src/index.ts` (`/api/blitz`, `/api/sniper`, `/api/scheduled` platform handling)

**Interfaces:**
- Consumes: `runOpenTableBookingWithContext`, `injectCookies`, `getFingerprint`/`summarizeFailures`/`safeShot` from `blitz.ts` (add `export` if missing), `BlitzConfig`/`BlitzResult`.
- Produces: `runOpenTableBlitz(req: BookingRequest, config: BlitzConfig, runAt?: string): Promise<BlitzResult>`; `getBookingEngine(...).runBlitz`.

- [ ] **Step 1: Implement `opentable/blitz.ts`** (mirror `blitz.ts`, swapping the per-attempt booking call to `runOpenTableBookingWithContext` and cookie injection to `'opentable'`)

```ts
// server/src/opentable/blitz.ts
import { chromium, Browser, Page } from 'playwright';
import { BookingRequest, BookingResult, STEALTH_ARGS } from '../booker';
import { BlitzConfig, BlitzResult, getFingerprint, summarizeFailures } from '../blitz';
import { injectCookies } from '../cookies';
import { buildOpenTableSearchUrl } from './url';
import { runOpenTableBookingWithContext } from './booker';

function sleep(ms: number) { return new Promise((r) => setTimeout(r, ms)); }

export async function runOpenTableBlitz(req: BookingRequest, config: BlitzConfig, runAt?: string): Promise<BlitzResult> {
  const startTime = Date.now();
  const n = Math.min(Math.max(config.attempts, 1), 5);
  const stagger = config.staggerMs;
  const offsets = Array.from({ length: n }, (_, i) => (i - Math.floor((n - 1) / 2)) * stagger);
  const minOffset = Math.min(...offsets);
  const normalized = offsets.map((o) => o - minOffset);
  const url = buildOpenTableSearchUrl(req.restaurant, req.dates[0], req.time, req.partySize);

  const warm: ({ browser: Browser; page: Page } | undefined)[] = [];
  const abort = new AbortController();
  try {
    const launches = await Promise.allSettled(Array.from({ length: n }, async (_, i) => {
      const fp = getFingerprint(i);
      const browser = await chromium.launch({ headless: true, channel: 'chromium', args: STEALTH_ARGS });
      const context = await browser.newContext({ viewport: fp.viewport, userAgent: fp.userAgent, locale: 'en-US', timezoneId: 'America/Los_Angeles' });
      if (await injectCookies(context, 'opentable') === 0) { await browser.close(); throw new Error('No OpenTable cookies'); }
      const page = await context.newPage();
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
      warm[i] = { browser, page };
    }));
    if (launches.every((l) => l.status === 'rejected')) {
      return { success: false, totalAttempted: 0, totalAborted: 0, durationMs: Date.now() - startTime,
        attempts: [], result: { success: false, error: 'All OpenTable browsers failed to warm' } };
    }

    if (runAt) {
      const waitMs = new Date(runAt).getTime() + minOffset - Date.now();
      if (waitMs > 0) await sleep(waitMs);
    }

    let winning: BookingResult | undefined; let winningAttempt: number | undefined;
    let attempted = 0, aborted = 0;
    const outcomes = await Promise.allSettled(warm.map(async (wb, i) => {
      if (!wb) { aborted++; return; }
      const delay = normalized[i] + Math.floor(Math.random() * 100);
      if (delay > 0) await sleep(delay);
      if (abort.signal.aborted) { aborted++; return; }
      attempted++;
      await wb.page.reload({ waitUntil: 'domcontentloaded', timeout: 30000 });
      if (abort.signal.aborted) return;
      const r = await runOpenTableBookingWithContext(wb.page.context(), req, abort.signal);
      if (r.success && !abort.signal.aborted) { winning = r; winningAttempt = i + 1; abort.abort(); }
    }));

    const durationMs = Date.now() - startTime;
    if (winning) return { success: true, winningAttempt, totalAttempted: attempted, totalAborted: aborted, durationMs, attempts: [], result: winning };
    return { success: false, totalAttempted: attempted, totalAborted: aborted, durationMs, attempts: [],
      result: { success: false, error: summarizeFailures ? summarizeFailures(outcomes as any) : `All ${attempted} OpenTable blitz attempts failed` } };
  } finally {
    await Promise.allSettled(warm.map((wb) => wb?.browser.close()));
  }
}
```

> NOTE: If `getFingerprint`/`summarizeFailures` are not exported from `blitz.ts`, add `export` to them in Task 7 Step 1a. If their signatures differ from assumed, adapt the call — verify by reading `blitz.ts` first. `runOpenTableBookingWithContext` takes a `BrowserContext`; pass `wb.page.context()`.

- [ ] **Step 1a: Ensure exports exist in `blitz.ts`**

Run: `cd server && grep -n "export function getFingerprint\|export function summarizeFailures\|function getFingerprint\|function summarizeFailures" src/blitz.ts`
If not exported, add `export` to their declarations. Commit that micro-change with Task 7.

- [ ] **Step 2: Add `runBlitz` to the dispatcher**

```ts
// engines.ts — extend the return type
import { runBlitz as runTockBlitz, BlitzConfig, BlitzResult } from './blitz';
import { runOpenTableBlitz } from './opentable/blitz';

export function getBookingEngine(platform: Platform = 'tock') {
  if (platform === 'opentable') {
    return { runBooking: runOpenTableBooking,
      runBlitz: (req: BookingRequest, cfg: BlitzConfig, runAt?: string) => runOpenTableBlitz(req, cfg, runAt) };
  }
  return { runBooking: runTockBooking,
    runBlitz: (req: BookingRequest, cfg: BlitzConfig, runAt?: string) => runTockBlitz(req, cfg, runAt) };
}
```

- [ ] **Step 3: Route `/api/blitz` by platform; reject `/api/sniper` for OpenTable**

In `index.ts` `/api/blitz`: `const engine = getBookingEngine(bookingReq.platform); const result = await engine.runBlitz(bookingReq, config);`.
In `index.ts` `/api/sniper`: after field validation add:
```ts
if (bk.platform === 'opentable') {
  return res.status(400).json({ success: false, error: 'Sniper mode is Tock-only for now (OpenTable sniper is Phase 2). Use /api/book or /api/blitz.' });
}
```
In `/api/scheduled`: if `rest.platform === 'opentable' && sniper` → `return res.status(400).json({ success:false, error:'OpenTable does not support sniper scheduling yet' })`.

- [ ] **Step 4: Route scheduler `executeBooking` by platform**

In `scheduler.ts` `executeBooking`, resolve the engine via `getBookingEngine(booking.platform)` for the blitz and single-shot branches (sniper branch stays Tock-only; OpenTable+sniper is already rejected at schedule time). Import `getBookingEngine`.

- [ ] **Step 5: Verify + smoke**

Run: `cd server && npx tsc --noEmit`. Then smoke `/api/blitz` with `platform:opentable` (expect no-cookies failure, not a crash) and `/api/sniper` with `platform:opentable` (expect the 400 rejection).

- [ ] **Step 6: Commit**

```bash
git add server/src/opentable/blitz.ts server/src/engines.ts server/src/index.ts server/src/scheduler.ts server/src/blitz.ts
git commit -m "feat(server): OpenTable blitz + platform dispatch in scheduler; reject OpenTable sniper"
```

---

## Task 8: Per-platform cookie routes + dashboard platform selector + OpenTable bookmarklet

**Files:**
- Modify: `server/src/index.ts` (cookie routes accept `platform`; `/health` + `/api/cookies/status` per-platform)
- Modify: `server/src/public/index.html` (platform selector, OpenTable bookmarklet, per-platform status)

**Interfaces:**
- Consumes: `getCookies`/`updateCookies` per-platform (Task 1).
- Produces: `POST /api/cookies?platform=`, `POST /api/cookies/push?key=&platform=`, `GET /api/cookies/status?platform=`.

- [ ] **Step 1: Server cookie routes accept `platform`**

`/api/cookies`: `const platform = (req.query.platform as Platform) || 'tock'; updateCookies(cookies, platform);`
`/api/cookies/push`: `const platform = (req.query.platform as Platform) || 'tock'; updateCookies(cookies, platform);`
`/api/cookies/status`: `const platform = (req.query.platform as Platform) || 'tock'; res.json({ platform, count: getCookies(platform).length, loaded: getCookies(platform).length > 0 });`
`/health`: report `{ tock: getCookies('tock').length, opentable: getCookies('opentable').length }` under `cookieCounts`.

- [ ] **Step 2: Dashboard — platform selector on Book/Scheduled**

Add a `<select id="platform"><option value="tock">Tock</option><option value="opentable">OpenTable</option></select>` to the Book and Scheduled forms; include `platform: document.getElementById('platform').value` in the `doBook`/`addSchedule`/blitz POST bodies.

- [ ] **Step 3: Dashboard — OpenTable bookmarklet + per-platform cookie status**

In Settings, add a second "Push OpenTable cookies" bookmarklet whose scraper reads `document.cookie` on `.opentable.com` and POSTs to `/api/cookies/push?key=<API_KEY>&platform=opentable`. Show both cookie counts from `/health` `cookieCounts`.

- [ ] **Step 4: Manual verify**

Run the server, load `/ui/`, confirm the platform selector renders and the OpenTable bookmarklet copies. POST cookies with `?platform=opentable` via curl and confirm `GET /api/cookies/status?platform=opentable` reflects it.

- [ ] **Step 5: Commit**

```bash
git add server/src/index.ts server/src/public/index.html
git commit -m "feat(server): per-platform cookie routes + dashboard platform selector & OpenTable bookmarklet"
```

---

## Task 9: Extension — OpenTable URL builder, drop-timing wiring, multi-date

**Files:**
- Modify: `src/utils/url-builder.ts`
- Test: `src/utils/url-builder.test.ts` (create; run via extension test runner or `npx tsx --test`)
- Modify: `src/background/index.ts`
- Modify: `src/content/index.ts`

**Interfaces:**
- Produces: `buildOpenTableSearchUrl(baseUrl, prefs)`, `buildOpenTableSearchUrlWithDate(baseUrl, prefs, date)`, `isOpenTableUrl(url)`.

- [ ] **Step 1: Write the failing test**

```ts
// src/utils/url-builder.test.ts
import { test } from 'node:test';
import assert from 'node:assert';
import { buildOpenTableSearchUrlWithDate, isOpenTableUrl } from './url-builder';

test('isOpenTableUrl detects opentable hosts', () => {
  assert.equal(isOpenTableUrl('https://www.opentable.com/r/nopa-san-francisco1'), true);
  assert.equal(isOpenTableUrl('https://www.exploretock.com/nopa'), false);
});

test('buildOpenTableSearchUrlWithDate builds datetime+covers URL', () => {
  const u = buildOpenTableSearchUrlWithDate('https://www.opentable.com/r/nopa-san-francisco1', { partySize: 2, time: '19:00' } as any, '2026-07-19');
  assert.match(u, /opentable\.com\/r\/nopa-san-francisco1\?datetime=2026-07-19T19%3A00&covers=2/);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx --test src/utils/url-builder.test.ts`
Expected: FAIL (functions not exported).

- [ ] **Step 3: Implement the OpenTable builders in `url-builder.ts`**

```ts
export function isOpenTableUrl(url: string): boolean {
  try { return /(^|\.)opentable\.[a-z.]+$/i.test(new URL(url).hostname); } catch { return false; }
}

function openTableSlug(baseUrl: string): string {
  const m = baseUrl.match(/opentable\.[a-z.]+\/r\/([^/?#]+)/i);
  return m ? m[1] : '';
}

export function buildOpenTableSearchUrlWithDate(baseUrl: string, prefs: { partySize: number; time: string }, date: string): string {
  const slug = openTableSlug(baseUrl);
  const datetime = encodeURIComponent(`${date}T${prefs.time}`);
  return `https://www.opentable.com/r/${slug}?datetime=${datetime}&covers=${prefs.partySize}`;
}

export function buildOpenTableSearchUrl(baseUrl: string, prefs: { partySize: number; time: string; date: string }): string {
  return buildOpenTableSearchUrlWithDate(baseUrl, prefs, prefs.date);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx tsx --test src/utils/url-builder.test.ts`
Expected: PASS.

- [ ] **Step 5: Wire background pre-nav + drop-refresh for OpenTable**

In `background/index.ts` `scheduleTimer` pre-nav switch: replace the OpenTable "do nothing" branch with `case 'opentable': targetUrl = buildOpenTableSearchUrl(tab.url, prefs); break;` and `tabs.update`. In `attemptFormFill`/`attemptManualFormFill`, treat OpenTable like Tock/Resy (reload-then-fill with `datesToTry`) using `buildOpenTableSearchUrlWithDate`. Import the new builders.

- [ ] **Step 6: Allow OpenTable in the multi-date content path**

In `content/index.ts` `AUTO_FILL_FORM` handler, add an `opentable` branch that calls `new OpenTableFormFiller(...).fill()` for each date in `datesToTry` (mirror the Resy multi-date loop), removing the "Multi-date mode only supported for Tock and Resy" rejection for OpenTable.

- [ ] **Step 7: Build the extension**

Run: `npm run build`
Expected: webpack completes with no errors.

- [ ] **Step 8: Commit**

```bash
git add src/utils/url-builder.ts src/utils/url-builder.test.ts src/background/index.ts src/content/index.ts
git commit -m "feat(ext): OpenTable URL builder + drop-timing wiring + multi-date"
```

---

## Task 10: RECON SPIKE — capture authenticated checkout DOM (needs user cookies)

> **BLOCKED until the user pushes OpenTable cookies + names one target restaurant (ideally card-required).** This task turns the checkout-DOM unknown into verified selectors.

**Files:**
- Create: `scratchpad/ot-checkout-recon.js` (throwaway; not committed)
- Modify: `server/src/opentable/selectors.ts` (fill the `checkout` section from recon output)
- Create: `opentable-booking-page.html` (repo-root fixture, committed like the other captures)

- [ ] **Step 1: Write the recon script** — inject the user's pushed OpenTable cookies into a headed Playwright context, navigate the target to the booking-details page (via slot click), and dump: all inputs (name/id/testid/autocomplete/placeholder), all buttons (testid/text), all iframes (src/title/name), whether Stripe is present, the "Amount due"/total text surface, and the full HTML. (Adapt `scratchpad/ot-recon.js` from the design phase — it already dumps this shape.)

- [ ] **Step 2: Run it with the user's cookies**

```bash
cd scratchpad && HEADED=1 node ot-checkout-recon.js '<target opentable /r/ URL>' target
```
Expected: `ot-checkout-recon-target-2-booking.{json,html,png}` written; console prints the confirm-button testid, contact inputs, and Stripe iframe info.

- [ ] **Step 3: Populate `selectors.ts` `checkout` section** with the real values (completeReservationButton, firstName/lastName/phone inputs, amountDueTextRoot, stripeCardIframe). Save the booking-page HTML to `opentable-booking-page.html` at repo root as a regression fixture.

- [ ] **Step 4: Record the payment classification** — note in the commit whether the target requires a card (Stripe present) or is free (skip `checkout.ts` fill).

- [ ] **Step 5: Commit**

```bash
git add server/src/opentable/selectors.ts opentable-booking-page.html
git commit -m "feat(server): recon-verified OpenTable checkout selectors + booking-page fixture"
```

---

## Task 11: OpenTable checkout completion + Stripe fill + price cap (server)

**Files:**
- Modify: `server/src/opentable/checkout.ts` (replace the stub)
- Test: `server/src/opentable/checkout.test.ts` (create — pure Amount-due parser)
- Consumes: `parseAmountDueCents` from `booker.ts` if reusable; else a local `parseOpenTableAmountDueCents`.

**Interfaces:**
- Consumes: `OT_SELECTORS.checkout` (Task 10), `getPayment` from `stripe.ts`, `freezeSession` from `sessions.ts`.
- Produces: `handleOpenTableCheckout(page, req, screenshots): Promise<CheckoutOutcome>` (real).

- [ ] **Step 1: Write the failing price-cap test**

```ts
// server/src/opentable/checkout.test.ts
import { test } from 'node:test';
import assert from 'node:assert';
import { parseOpenTableAmountDueCents } from './checkout';

test('parses the largest dollar total and ignores per-person lines', () => {
  assert.equal(parseOpenTableAmountDueCents('Amount due per person $125\nTotal due $250.00'), 25000);
});
test('returns null when no dollar total present (fail-closed)', () => {
  assert.equal(parseOpenTableAmountDueCents('50% deposit required'), null);
});
test('free booking (no total) returns 0 via caller guard, parser returns null', () => {
  assert.equal(parseOpenTableAmountDueCents('You will not be charged'), null);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd server && npx tsx --test src/opentable/checkout.test.ts`
Expected: FAIL (`parseOpenTableAmountDueCents` not exported).

- [ ] **Step 3: Implement real `checkout.ts`**

Implement `parseOpenTableAmountDueCents(text)` (largest `$X` after a total label; `null` if none) and `handleOpenTableCheckout`:
1. Wait for `OT_SELECTORS.checkout.completeReservationButton`.
2. Confirm/fill contact inputs if empty (from a config, reusing billing name / a stored phone).
3. If a Stripe iframe (`OT_SELECTORS.checkout.stripeCardIframe`) is present AND `getPayment()` has a card → fill card/expiry/CVC into the iframe (Playwright frame locator, mirroring `stripe.ts`). If Stripe present but no card configured → freeze + return `{success:false, error:'card required but none configured'}`.
4. Read the total text under `amountDueTextRoot`; `const cents = parseOpenTableAmountDueCents(text)`. **Fail-closed:** if a Stripe section was present and (`cents === null` || `cents > req.maxPriceCents`) → do not confirm; `freezeSession(...)`; return held-only.
5. If `dryRun` → screenshot + return `{success:true}` WITHOUT clicking confirm.
6. Else click `completeReservationButton`, wait for confirmation, screenshot, return `{success:true}`.

(Write the full function body against the recon-verified selectors from Task 10. Include the `req.maxPriceCents` field on `BookingRequest` — add it in Task 1's type if not already present; default behavior: if `maxPriceCents` is undefined and a Stripe section is present, treat as free-only and fail-closed on any nonzero total.)

- [ ] **Step 4: Run tests to verify pass**

Run: `cd server && npx tsx --test src/opentable/checkout.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Dry-run end-to-end (needs user cookies)**

```bash
curl -s -XPOST localhost:3000/api/book -H 'content-type: application/json' \
  -d '{"platform":"opentable","restaurant":"<target>","dates":["<date>"],"partySize":2,"time":"19:00","dryRun":true,"maxPriceCents":5000}'
```
Expected: `success:true` with screenshots showing the reached-but-not-confirmed checkout (or a fail-closed held-only if over cap). No reservation actually booked.

- [ ] **Step 6: Commit**

```bash
git add server/src/opentable/checkout.ts server/src/opentable/checkout.test.ts server/src/booker.ts
git commit -m "feat(server): OpenTable checkout completion + Stripe fill under fail-closed price cap"
```

---

## Task 12: Extension checkout continuation + `cvc-server` OpenTable Stripe filler + docs

**Files:**
- Modify: `src/content/opentable-form-filler.ts`
- Modify: `scripts/cvc-server.js`
- Modify: `docs/ARCHITECTURE.md`, `README.md`

**Interfaces:**
- Consumes: `localhost:3847/trigger-cvc` (existing helper); recon selectors (Task 10).
- Produces: `buildOpenTableStripeFillerScript(config, coords)` in `cvc-server.js`.

- [ ] **Step 1: Extend `OpenTableFormFiller`** to continue past the slot click: wait for the booking-details page, fill/confirm contact fields, and if a Stripe iframe is present compute its viewport coords and POST to `localhost:3847/trigger-cvc` (with a flag `platform:'opentable'`), then click the recon-verified `completeReservationButton`. Reuse the Amount-due sanity guard before the final click.

- [ ] **Step 2: Add `buildOpenTableStripeFillerScript` to `cvc-server.js`** — mirror `buildStripeFillerScript`, adjusting field click ratios to OpenTable's Stripe layout (from recon). Route it in `runCardAutomation` when the request body has `platform:'opentable'`.

- [ ] **Step 3: Build + manual verify**

Run: `npm run build`. Load the unpacked extension, start `node scripts/cvc-server.js`, and on the target OpenTable page run a fill — confirm it reaches checkout and (dry, without final confirm if a dry toggle exists) fills the card. Otherwise verify up to the confirm button.

- [ ] **Step 4: Update docs** — add an "OpenTable engine" subsection to `ARCHITECTURE.md` (§5 file index + a short flow note) and an OpenTable operation section to `README.md` (push cookies, platform selector, card requirement, dry-run first).

- [ ] **Step 5: Commit**

```bash
git add src/content/opentable-form-filler.ts scripts/cvc-server.js docs/ARCHITECTURE.md README.md
git commit -m "feat(ext): OpenTable checkout continuation + cvc-server OpenTable Stripe filler; docs"
```

---

## Self-Review

**Spec coverage:**
- §4.1 platform dispatch → Tasks 1, 6, 7. §4.2 per-platform cookies → Task 1, 8. §4.3 OpenTable booker → Tasks 5, 11. §4.4 blitz → Task 7. §4.5 payment → Task 11, 12. §4.6 URL/identity → Tasks 2, 9. §4.7 API + dashboard → Tasks 6, 7, 8. §5 extension → Tasks 9, 12. §6 data model → Task 1. §7 recon spike → Task 10. §8 testing → Tasks 1–3, 11 (unit) + dry-run steps. §9 rollback/back-compat → default `'tock'` enforced in Tasks 1, 6, 7. All covered.
- Phase-2 sniper correctly excluded (Task 7 Step 3 rejects it).

**Placeholder scan:** The only deferred values are the `checkout` selectors in `selectors.ts`, which are (a) real named constants with provisional values that compile, and (b) explicitly populated by the defined Task 10 recon — an ordered dependency, not a "fill in later" gap. All other steps contain complete code. Task 11 Step 3 describes the checkout function in prose+contract rather than full code because its exact selectors are recon-derived (Task 10) — the implementer writes the body against verified selectors; the parser (the testable pure part) has full code.

**Type consistency:** `Platform` defined in `cookies.ts`, imported everywhere. `BookingRequest.platform?`/`.maxPriceCents?` added in Task 1 and used in Tasks 6, 7, 11. `getBookingEngine` return shape extended consistently (Task 6 adds `runBooking`, Task 7 adds `runBlitz`). `runOpenTableBookingWithContext` takes a `BrowserContext` (Task 5) and is called with `wb.page.context()` (Task 7). `handleOpenTableCheckout`/`CheckoutOutcome` defined in Task 5 stub, replaced in Task 11 with the same signature. `parseSlots`/`pickBestSlot`/`OpenTableSlot` consistent across Tasks 3 and 5.

**Ordering:** Tasks 1–9 need no user cookies and are fully build/test-able now; Tasks 10–12 are gated on the user's OpenTable cookies + target. This lets ~75% of the work proceed immediately.
