# OpenTable Reservation Grabber — Design

**Date:** 2026-07-05
**Branch:** `rz/opentable-grabber`
**Status:** Approved (design); ready for implementation plan

## 1. Goal

Build the OpenTable equivalent of the existing Tock reservation grabber, functionally
the same, deployed to the **same Railway server** and reusing the same dashboard,
scheduler, history, SSE, frozen-session recovery, and price-cap safety model. Cover
**both halves** of the system:

1. **Server grabber** (`server/`) — headless Playwright engine that books OpenTable
   reservations autonomously, wired into the existing `/api/book`, `/api/blitz`,
   `/api/sniper`, and `/api/scheduled` routes.
2. **Extension checkout** (`src/`) — finish the in-browser OpenTable auto-purchase so
   the Chrome extension can complete a booking (currently it stops at the slot click).
3. **Payment** — automate OpenTable's Stripe checkout for restaurants that require a
   card/deposit (server via Playwright, extension via the `localhost:3847` helper).

### Decisions locked with the user (2026-07-05)

- **Scope:** server grabber **+** extension checkout (both halves).
- **Auth:** logged-in via **pushed session cookies** (bookmarklet, mirroring Tock).
  Server-side OpenTable auto-login is **deferred** (reCAPTCHA is harder to pass
  headlessly than Tock's Turnstile).
- **Payment:** target restaurants **may require a card/deposit** → build OpenTable
  payment automation (OpenTable uses **Stripe SCA SetupIntent**).

## 2. Key facts driving the design

From the saved `opentable-nopa.html` capture, the existing `OpenTableFormFiller`, and
live recon on 2026-07-05:

- **OpenTable blocks cookieless automation.** A fresh Playwright browser (headed *and*
  headless) gets an Akamai-style **"Access Denied"** on restaurant/profile pages; the
  homepage is open. → The engine **must** carry the user's real logged-in cookies, and
  the exact authenticated checkout selectors can only be captured **with the user's
  session present** (see the recon spike, §7).
- **OpenTable has a real availability API.** Unlike Tock (which has *no* JSON endpoint
  and hides availability in the search HTML's `$REDUX_STATE`), OpenTable serves
  availability from a `/dapi/` **GraphQL** gateway and hydrates `window.__APOLLO_STATE__`.
  Availability deep-links use tokens: `rid` (numeric restaurant id), `avt` (base64
  availability token), `corrid` (correlation id), `sd` (start datetime ISO), `p`
  (party). This means an OpenTable *sniper* could poll GraphQL directly — cleaner than
  Tock's HTML-scraping — **but** mutations are guarded by `window.__CSRF_TOKEN__` **and
  reCAPTCHA** (`window.__INCLUDE_RECAPTCHA__`).
- **A real browser mints valid CSRF + reCAPTCHA tokens for free.** This is exactly why a
  DOM-driven Playwright engine (like `booker.ts`) is the robust path, and why replaying
  the private GraphQL API blind is *not* v1.
- **Most OpenTable bookings are free**, but the targeted ones may require a Stripe card
  guarantee (charged on no-show) or a real prepaid charge for "Experiences". Either way
  it is **Stripe**, so the existing fail-closed **Amount-due price cap** applies.
- **Profile-page selectors are already known/verified** in `OpenTableFormFiller`:
  party `#restaurantProfileDtpPartySizePicker`, date `[data-testid="day-picker-overlay"]`
  (react-day-picker `.rdp-*`), time select real id `restaurantProfiletimePickerDtpPicker`,
  slots `[data-testid^="time-slot-"]` with inner `[role="button"]` (text like `6:00 PM*`).

## 3. Phasing

The Tock grabber's competitive core (`sniper.ts`: fast in-page availability poll +
reverse-engineered protobuf lock + `x-tock-*` header replay + single-winner mutex) took
~20 PRs and deep live reverse-engineering to build. The OpenTable equivalent of that
depth **requires the user's live session** to capture the GraphQL protocol, which we
don't have yet. So we phase:

- **Phase 1 (this build): reliable DOM engine + full checkout + payment + extension.**
  A `booker.ts`/`blitz.ts`-equivalent OpenTable engine: navigate the (cookied) search
  page → poll/refresh for slots → click the matching slot → complete the booking-details
  page → fill Stripe if required (fail-closed under the price cap) → confirm, or freeze
  for manual recovery. Wired into `/api/book`, `/api/blitz`, `/api/scheduled`, the
  dashboard, history, SSE, and `sessions.ts`. This is fully buildable now (modulo the
  §7 recon spike for the authenticated checkout selectors).
- **Phase 2 (future, not this build): OpenTable sniper.** A `sniper.ts`-equivalent that
  polls the `/dapi/` GraphQL availability via in-page `fetch()` and grabs via the
  reservation-hold mutation (with page-minted CSRF + reCAPTCHA tokens). Requires
  capturing OpenTable's GraphQL request/response shapes from the user's live session
  first. Explicitly **out of scope** here; the Phase-1 abstractions leave room for it.

This spec covers **Phase 1** in full. Phase 2 is noted only so Phase-1 seams don't
foreclose it.

## 4. Server design (`server/`)

### 4.1 Platform routing — new code, no relocation of Tock

Add an optional `platform: 'tock' | 'opentable'` field to the booking request
(**defaulting to `'tock'`** so every existing call and stored schedule is byte-for-byte
unchanged). A thin dispatcher routes to the right engine:

```
server/src/
  engines.ts            ← NEW. getBookingEngine(platform) → { runBooking, runBlitz }
                          (Phase 2 adds runSniper). Tock maps to the existing
                          booker/blitz; opentable maps to the new modules below.
  opentable/
    booker.ts           ← NEW. runOpenTableBooking / runOpenTableBookingWithContext /
                          handleOpenTableCheckout. Mirrors booker.ts' structure + the
                          fail-closed price-cap contract.
    blitz.ts            ← NEW. runOpenTableBlitz — warm N contexts, staggered reloads,
                          single-winner abort. Mirrors blitz.ts.
    checkout.ts         ← NEW. OpenTable Stripe SCA fill (Playwright), reusing the
                          Amount-due price-cap gate.
    availability.ts     ← NEW. Parse OpenTable slots from the DOM (Phase 1) with a seam
                          for GraphQL parsing (Phase 2).
```

**Why not move the Tock files into `server/src/tock/`** (as floated during
brainstorming): `sniper.ts`/`booker.ts`/`blitz.ts`/`cookies.ts`/`stripe.ts` are deeply
interconnected, battle-tested against Cloudflare + Tock's protobuf, and relocating them
means import churn across the most fragile code in the repo for zero functional gain.
We get the same per-platform separation by adding an `opentable/` folder + a dispatcher
and leaving the proven Tock engine exactly where it is. (Optional future cleanup, not
this PR.)

`scheduler.ts` `executeBooking` gains the same dispatch: pick sniper > blitz > single
per existing logic, but resolve the engine by `booking.platform`. For Phase 1, an
OpenTable schedule with a `sniper` config is rejected at schedule time (no OpenTable
sniper yet) — fail-closed, with a clear error.

### 4.2 Per-platform cookies

Generalize `cookies.ts` from a single Tock jar to a per-platform jar:

- Storage: `store.ts` keeps `cookies` (Tock, unchanged for back-compat) and adds
  `opentableCookies`. `loadCookiesFromEnv` also reads an `OPENTABLE_COOKIES` base64 env
  fallback.
- API: `getCookies(platform='tock')`, `updateCookies(cookies, platform='tock')`,
  `injectCookies(context, platform='tock')`. Defaults preserve every existing Tock call
  site. OpenTable cookie defaults use domain `.opentable.com`.
- `/health` and `/api/cookies/status` report per-platform counts.

### 4.3 OpenTable booking flow (`opentable/booker.ts`)

`runOpenTableBookingWithContext(context, req, signal?)`:

1. Inject OpenTable cookies; navigate the **search/profile URL** built from the
   restaurant identifier + `dates[0]` + party + time (see §4.6 URL building).
2. Wait for the react-day-picker + party/time controls (selectors from
   `OpenTableFormFiller`, re-verified in the recon spike).
3. For each requested date that the calendar shows available: select the date, read the
   `[data-testid^="time-slot-"]` slots, pick the exact-or-closest match to `req.time`,
   click it. (Multi-date iteration, mirroring Tock.)
4. The slot click navigates to OpenTable's **booking-details page** (authenticated via
   cookies). Complete it: confirm contact details are prefilled, accept any required
   terms, and — **if the restaurant requires payment** — drive `checkout.ts`.
5. **Fail-closed price cap:** before the final "Complete reservation" click, reuse
   `parseAmountDueCents`-style logic to read the total and abort if missing or over cap.
   `dryRun` stops here (rehearsal, no confirm), exactly like the Tock path.
6. On success, capture the confirmation number. On a held-but-unconfirmed/ambiguous
   state, **freeze the session** (`sessions.ts`) for manual recovery instead of tearing
   it down.

Return the existing `BookingResult` shape (`success`, `bookedDate`, `bookedTime`,
`error`, `screenshots`) so history/SSE/notifications work unchanged.

### 4.4 OpenTable blitz (`opentable/blitz.ts`)

Reuse `blitz.ts`' proven structure: warm N fingerprint-varied contexts (each with
OpenTable cookies) on the search page, wait to the drop, stagger reloads, run the
booking on each, first success aborts the rest. Reuse `getFingerprint`, `summarizeFailures`,
`safeShot` from `blitz.ts` (extract to a shared helper if cleaner, otherwise import).

### 4.5 Payment (`opentable/checkout.ts`)

OpenTable's checkout uses **Stripe** (SCA SetupIntent for guarantees; a real charge for
Experiences). The existing `PaymentDetails` type already carries card + billing fields.
`checkout.ts` fills OpenTable's Stripe element(s) via Playwright — structurally like
`stripe.ts`' `fillStripePayment`/`fillStripeBilling` but against OpenTable's DOM
(selectors captured in the recon spike). Same source-of-truth priority (`getPayment()`:
disk override → env → null) and the same **fail-closed** rule: no card configured →
can't run a real (non-dry) paid booking.

### 4.6 Restaurant identifier & URL building

Tock uses a slug (`req.restaurant` = first path segment). OpenTable uses a numeric `rid`
plus a slug. Keep `req.restaurant` as the operator-facing field but accept **either** an
OpenTable slug (`nopa-san-francisco1`) or a canonical URL, and resolve it to the search
URL: `https://www.opentable.com/r/{slug}?datetime={date}T{time}&covers={party}`. A small
`opentable/url.ts` (server) mirrors the extension's `buildOpenTableSearchUrl` (§5.1) so
both halves construct identical URLs.

### 4.7 API & dashboard changes

- `POST /api/book`, `/api/blitz`, `/api/scheduled` accept optional `platform` (default
  `'tock'`). `/api/sniper` rejects `platform: 'opentable'` in Phase 1 (clear error).
- `POST /api/cookies/push?key=...&platform=opentable` and `POST /api/cookies` accept an
  optional `platform` param → the right jar. A second **bookmarklet** on the dashboard
  scrapes `.opentable.com` cookies (parallel to the Tock one).
- Dashboard: a **platform selector** on the Book/Scheduled tabs; the Settings tab shows
  per-platform cookie status and the OpenTable bookmarklet. Everything else (history,
  SSE, sessions, payment) is already platform-neutral.

## 5. Extension design (`src/`)

### 5.1 URL building & drop-timing wiring

- Add `buildOpenTableSearchUrl` / `buildOpenTableSearchUrlWithDate` / `isOpenTableUrl`
  to `url-builder.ts` (currently Tock + Resy only).
- `background/index.ts`: replace the "do nothing for OpenTable" pre-navigation with a
  real pre-nav to the built search URL, and enable the drop-time reload-then-fill path
  (currently OpenTable falls back to single-date, no refresh).

### 5.2 Finish `OpenTableFormFiller` checkout

Continue past the slot click (which today ends the flow):

1. After the slot click navigates to the booking-details page, wait for it, confirm/fill
   contact details, accept required terms.
2. If a Stripe payment section is present, detect its cross-origin iframe coordinates and
   hand them to the `localhost:3847` helper (mirroring `form-filler.ts`'
   `handlePurchaseConfirmation`).
3. Enforce the same Amount-due sanity check, then click "Complete reservation".

### 5.3 `cvc-server.js` OpenTable Stripe filler

Add a `buildOpenTableStripeFillerScript` alongside `buildStripeFillerScript` /
`buildBraintreeFillerScript`, tuned to OpenTable's Stripe field layout (coordinates from
recon). Same AppleScript + `cliclick` mechanism.

### 5.4 Multi-date support

Allow OpenTable in the content-script multi-date path (currently rejected as "Tock/Resy
only") by walking the react-day-picker across desired dates — mirroring the Tock/Resy
`tryMultipleDates`.

## 6. Data model changes (`src/types` + server)

- `BookingRequest` (server) gains `platform?: 'tock' | 'opentable'` (default `'tock'`).
- `ScheduledBooking` inherits it via `...rest`.
- Extension `Platform` type already includes `'opentable'`; no change. `TockPreferences`
  already carries the card/billing fields used for OpenTable payment.

## 7. Recon spike (implementation Task 1) — de-risks everything downstream

Because OpenTable blocks cookieless automation, the **first task** captures the real
authenticated flow with the user's pushed cookies:

1. User pushes their OpenTable cookies (via the new bookmarklet or a one-off dump).
2. A local script injects those cookies into a Playwright context, navigates a real
   target restaurant to the booking-details + payment page, and dumps: the exact
   booking-details DOM (contact fields, terms checkboxes, "Complete reservation"
   button), whether/how the Stripe iframe(s) appear, the Amount-due text surface, and
   the confirmation-page shape.
3. These captured selectors are written into `opentable/booker.ts` / `checkout.ts` and
   `OpenTableFormFiller`, replacing provisional selectors.

This spike converts the one genuine unknown (authenticated checkout DOM) into verified
fact before the booker/payment code is finalized. It needs **one target restaurant**
(ideally a card-required one) and the user's **OpenTable session cookies**.

## 8. Testing strategy

- **Pure helpers** get unit tests (mirroring the Tock engine's tested helpers): slot
  parsing/matching, URL building, Amount-due parsing for OpenTable's price surface,
  platform dispatch.
- **`dryRun`** rehearses the whole flow (search → hold slot → fill card) and stops
  before the final confirm — the primary safe end-to-end check, run locally with the
  user's cookies.
- **Local run with real cookies** against the target restaurant validates search →
  booking-details → (dry) checkout before deploying.
- **Back-compat:** existing Tock unit tests must stay green; `platform` defaulting to
  `'tock'` means no Tock behavior changes.

## 9. Rollout, back-compat, deployment

- `platform` defaults to `'tock'` everywhere → **zero behavior change** for existing
  Tock bookings, schedules, and the dashboard.
- No new infrastructure: same Railway service, same Playwright/Chromium image, same
  `/data` volume (adds one `opentableCookies` key to `state.json`).
- Ship behind the existing auth; add the OpenTable bookmarklet + platform selector to
  the dashboard. `npm run build` (extension) and `tsc` (server) as today.

## 10. Risks & mitigations

- **Bot detection / "Access Denied"** — mitigated by always carrying the user's real
  session cookies; the recon spike confirms the cookied flow reaches checkout. If
  OpenTable blocks even the cookied headless server, fall back to the extension half
  (real user browser) — which is why both halves are in scope.
- **Cookie expiry** — same operational model as Tock: re-push via bookmarklet. Auto-login
  deferred (reCAPTCHA).
- **Checkout selectors drift** — the fail-closed price cap + freeze-for-recovery mean a
  selector break results in a *frozen session to finish by hand*, never an overpay or a
  silent miss (reusing the Tock safety model).
- **Payment variance** (guarantee vs prepaid vs free) — the recon spike classifies the
  target; free restaurants skip `checkout.ts` entirely.

## 11. Out of scope (this build)

- OpenTable **sniper** (GraphQL fast-poll + API-grab) — Phase 2.
- Server-side OpenTable **auto-login** — deferred (reCAPTCHA); cookie-push only.
- Resy checkout/payment — unchanged.
