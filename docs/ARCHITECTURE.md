# tock-bot — Architecture Overview

Onboarding documentation for engineers new to the codebase. This describes how
the system is put together, how a snipe flows end-to-end, the reverse-engineered
Tock facts that everything depends on, and where each file lives.

> Companion to `README.md` (setup/usage). This doc is about **how it works**.

---

## 1. The two halves

tock-bot is a reservation **sniper** for [Tock](https://www.exploretock.com)
(with best-effort support for OpenTable and Resy). It is two independent
programs that solve the same problem — "grab a hard-to-get reservation the
instant it becomes bookable" — from opposite ends:

### A. The headless server (`server/src/`)

A Node/TypeScript + Express service that runs **headless Playwright/Chromium**
browsers, designed to be deployed on Railway (persistent `/data` volume). It
logs in as a real Tock user, watches for reservation "drops," and books them
autonomously — no human at the keyboard. This is the competitive core: it can
warm a pool of browsers minutes ahead of a drop, poll availability many times a
second across the drop window, win a single-winner race, and complete checkout
under a hard price cap. It exposes a REST/SSE API plus a dashboard
(`server/public/`) for scheduling snipes and inspecting outcomes.

### B. The Chrome extension (`src/`)

A Manifest V3 browser extension that a human installs. It fills the
reservation/checkout forms **on the live pages the user is already looking at**
— Tock, OpenTable, and Resy — and can schedule a countdown to a known drop time,
then auto-fill/auto-submit at T-0. It is the "assistant" half: lower ceiling
than the server, but it runs in the user's real, logged-in browser session with
their real fingerprint, which sidesteps a lot of anti-bot friction.

### How they relate

They **do not talk to each other** and do not share a booking engine. They are
two delivery vehicles for the same reverse-engineered understanding of how Tock's
booking flow works (see §3). Concretely they overlap in two places:

- **Cross-origin Stripe checkout.** Both halves must fill Tock's Stripe
  **Payment Element** (card number / expiry / CVC) and **Address Element**
  (billing name / address) which live in **cross-origin iframes**. The server
  can drive them directly via Playwright (`server/src/stripe.ts`) because it
  controls the browser. The extension **cannot** inject into a cross-origin
  iframe, so it hands the iframe's on-screen coordinates + card details to a
  local macOS helper (`scripts/cvc-server.js` on `localhost:3847`) that replays
  real OS-level mouse clicks and keystrokes (AppleScript + `cliclick`).
- **The same Tock facts.** Both encode the same knowledge of Tock's search-page
  data shape, the add-ons interstitials, and the checkout price surface.

Pick the server for maximum speed/autonomy on a known drop; pick the extension
when you want the human's real session in the loop or you're on OpenTable/Resy.

```
          ┌──────────────────────────── SERVER (Railway) ───────────────────────────┐
          │  index.ts (Express API + SSE + dashboard)                                │
          │     │                                                                    │
          │  scheduler.ts ──► sniper.ts  (warm pool → poll → lock/grab → purchase)   │
          │             └───► blitz.ts   (N parallel booking attempts)               │
          │             └───► booker.ts  (single-shot booking + Stripe checkout)     │
          │  cookies/session/login/store/stripe/notify/sessions  (support)           │
          └──────────────────────────────────────────────────────────────────────────┘

          ┌──────────────────────── CHROME EXTENSION (user's browser) ──────────────┐
          │  popup (React)  ──►  background/index.ts (MV3 worker: alarms, routing)   │
          │                          │                                               │
          │                     content/*-form-filler.ts (Tock/OpenTable/Resy)      │
          │                          │ (cross-origin Stripe iframe coords)          │
          │                     scripts/cvc-server.js  (localhost:3847, AppleScript) │
          └──────────────────────────────────────────────────────────────────────────┘
```

---

## 2. The sniper data flow, end to end

This is the server's competitive path. The engine is
**`server/src/sniper.ts`**, entry point **`runSniper(config)`**. A snipe is
usually kicked off by `scheduler.ts` (a `runAt` schedule fires ~15s early to
leave time to warm) or by `POST /api/sniper` for an immediate run.

The flow, with the functions that own each stage:

### Stage 0 — Session guard (before anything)

Callers ensure a valid logged-in Tock session first (`session.ts →
ensureValidSession()`), so the warm browsers act as an authenticated user. The
authenticated cookies come from `cookies.ts` and are injected into each
Playwright context (`injectCookies()`).

### Stage 1 — Warm

`runSniper` warms a **pool of headless Chromium browsers** ahead of the drop.
Warming means launch + inject session cookies + load the venue's search page so
Cloudflare `cf_clearance` is established and the page's request machinery is
primed. Warming is retried on the intermittent Cloudflare "warm-up challenge"
seen on some modal-UI venues (see §3). This is why scheduled snipes start ~15s
early.

### Stage 2 — Poll / detect

Across the **drop window** (`computeWindowOffsets` decides the polling cadence /
coverage), each warm browser densely polls the **search page's embedded
availability**. There is **no JSON availability endpoint** — availability lives
inside the search HTML's `$REDUX_STATE` under `calendar.offerings` (§3). Two read
paths:

- **Fast path (preferred):** an **in-page `fetch()`** of the search HTML from the
  same origin — it carries the session cookies + `cf_clearance`, so Cloudflare
  serves it without a challenge and there is **no document navigation** (so no
  Turnstile is ever drawn). `extractOfferingsFromHtml()` surgically slices just
  the `"offerings":{…}` subtree out of the `$REDUX_STATE` JS literal and
  JSON-parses it (the wider Redux blob contains functions and bare `undefined`
  and can't be parsed whole; the offerings subtree has bare `undefined` but no
  functions, which the extractor repairs).
- **Navigate fallback:** if the fast path misses twice in a row it falls back to
  a real navigation + read.

`parseAvailability(offerings, partySize)` turns the offerings arrays into
`NormalizedSlot`s. `pickBestSlot()` (with `pickFallbackTime12()`) selects the
slot matching the operator's preferred time/party from the current poll. Per-run
poll accounting (fast vs nav vs challenges vs matched) is tracked for the
dashboard `SniperMeta`.

### Stage 3 — Single-winner lock

Multiple warm browsers may see the slot in the same poll tick. A
`SingleWinnerLock` mutex guarantees **exactly one** browser proceeds to grab —
the rest stand down. This prevents self-collision (two of our own browsers
racing the same slot and double-booking / conflicting).

### Stage 4 — Grab (hold the slot)

The winner holds the slot by one of two paths:

- **Primary — direct-API lock (Cloudflare-proof):** an **in-page `fetch()`** of
  `PUT /api/ticket/group/lock` with a **reverse-engineered protobuf body**
  (`encodeTockLock`), reusing the warm session's `cf_clearance` and the
  captured/reconstructed `x-tock-*` headers (§3). Because it's an in-page fetch
  (no navigation) it never draws Turnstile. `lockResponseVerdict()` classifies
  the response as **held** (a real lock echoes a large ~1200+ byte protobuf with
  reservation text) / **conflict** (slot was just taken → retry another time or
  fall back) / **blocked** (challenge or not-logged-in → retryable within the
  window). A tiny ~89-byte response is *not* a real lock.
- **Fallback — hybrid reload + click:** reload the search page and click the
  slot's book button in the DOM, exactly like the extension does. Slower and it
  can hit Turnstile, but it's a safety net — "never worse than the old
  behavior." A "no longer available" message after the click means we lost the
  click race (retryable).

### Stage 5 — Checkout + price cap

With the slot held, the winner completes purchase through the **shared
fail-closed checkout flow** in `booker.ts`
(`runBookingWithContext → handlePurchaseFlow`, which sniper drives on the warm
context with an `AbortSignal`). This is a polling **state machine** over Tock's
checkout interstitials (add-ons / gratuity / order-review / confirm). Payment is
filled either as **saved-card** (CVC only) or **new-card** (full Stripe fill via
`stripe.ts`). Before the final confirm click it enforces the **price cap**:
`parseAmountDueCents()` reads the grand-total "Amount due $X" off the confirm
page and compares against the configured cap. **Fail-closed:** if the total is
missing/unparseable, or over cap, it aborts rather than pay (see §4).

### Stage 6 — Outcome / freeze-for-recovery

`runSniper` returns a `SniperResult`. If a slot was **held but purchase did not
complete** (e.g. an ambiguous checkout state, price-cap abort you want to review,
or a transient error), the winning browser session is **frozen** via
`sessions.ts → freezeSession()` instead of being torn down — parked live so an
operator can finish checkout by hand from the dashboard **Live Sessions** panel
(`applyAction`: re-enter-cvc / retry-purchase / refresh-screenshot / abort). The
run outcome (plus `SniperMeta` diagnostics: poll counts, why it missed) is
recorded to in-memory history by `scheduler.ts` and streamed to the dashboard
over SSE (`GET /api/events`), and optionally pushed to Slack (`notify.ts`).

**One-line summary of the path:**
`warm pool → poll $REDUX_STATE offerings (fast in-page fetch) → single-winner
mutex → API lock protobuf (fallback reload+click) → fail-closed Stripe checkout
under Amount-due price cap → success, or freeze for manual recovery.`

**Blitz** (`blitz.ts`, `POST /api/blitz`) is a sibling strategy, not part of the
sniper path: it fires up to 5 **independent, fingerprint-varied** booking
attempts in parallel, staggered around the drop, first success wins and aborts
the rest. Use it when you'd rather brute-force parallel single-shots than run the
poll/lock engine.

---

## 3. Reverse-engineered Tock facts (the load-bearing knowledge)

Everything above only works because of specific, empirically-confirmed facts
about how Tock actually behaves. These are the assumptions a new engineer most
needs to internalize — if Tock changes them, the sniper breaks here first.

### There is no JSON availability endpoint

Tock does **not** expose a clean "is this slot open?" JSON API you can poll.
Availability is embedded in the **search page HTML** as a JavaScript literal
assigned to **`$REDUX_STATE`**, under **`calendar.offerings`** — parallel arrays
describing every bookable date/time/experience. So "polling availability" means
**refetching the search HTML and re-parsing that blob** every tick. Key code:

- `extractOfferingsFromHtml(html)` — finds the `$REDUX_STATE` marker, slices out
  just the `"offerings":{…}` subtree, and repairs it into valid JSON. It parses
  *only* offerings (not the whole Redux state) because the full blob contains
  functions (unparseable); the offerings subtree contains bare `undefined` but
  no functions, so it can be surgically repaired.
- `parseAvailability(offerings, partySize)` → `NormalizedSlot[]`.
- Confirmed by live recon 2026-06-27.

### The lock protobuf: `PUT /api/ticket/group/lock`

Holding a slot without navigating (the Cloudflare-proof path) means calling
Tock's own lock endpoint the way the app does — a **binary protobuf** body,
reverse-engineered in `encodeTockLock(partySize, dateTime, experienceId, …)`:

- **`f6` = the per-person prepaid price in cents.** This matters:
  prepaid/tasting-menu venues (omakase, FHH, Lazy Bear `42000`, craft-omakase
  `18500`, …) **reject a wrong or zero `f6`**. For direct-book (non-prepaid)
  cases it can be `0`. Getting this wrong turns a would-be lock into a rejection.
- `f13` = `seatingAreaId` (omitted for a direct lock).
- `lockResponseVerdict(status, body)` classifies the result: HTTP 200 with a
  **large** protobuf (~1200+ bytes, echoing reservation text) = a **real hold**;
  a tiny ~89-byte 200 or a challenge = **not** a hold → retry or fall back.

### `x-tock-*` headers are reused, not forged

Tock's authenticated API calls carry `x-tock-session`, `x-tock-fingerprint`,
`x-tock-stream-format: proto2`, etc. The sniper **captures these from the app's
own requests** (a request listener keeps the latest `x-tock-session`-bearing
header set from any same-origin request) and **replays them** on its in-page
lock fetch. `x-tock-session` / `x-tock-fingerprint` are stable per session.

- **Modal-UI venues fire none passively.** Some restaurants (n/naka, FHH) render
  a **modal** booking UI and fire **zero** `x-tock-*` requests just from loading
  the search page (confirmed 2026-07-05: 0 `x-tock` reqs seen). For these there's
  a **fallback that reconstructs the `x-tock-*` set from page state** so the lock
  fetch still has valid headers. Other venues use an **inline** UI that fires
  those requests on load, so capture works passively.

### Cloudflare: the warm-up challenge, Turnstile, and why in-page fetch wins

- The **in-page `fetch()`** carries the session's cookies + `cf_clearance`, so
  Cloudflare serves it without a challenge, and — crucially — it performs **no
  document navigation**, so it **never draws the Turnstile challenge** that a
  full page reload can. This is the whole reason the fast poll path and the API
  lock path exist.
- **Warm-up challenge:** warming a browser occasionally hits an intermittent
  Cloudflare challenge on load (e.g. FHH warmed fine on 2026-07-03 but not
  always). Warming **retries** on this.
- A challenge encountered during a poll or a lock is treated as **retryable**
  within the ~10-minute drop window, not a hard failure.

### Inline UI vs modal UI

A recurring axis: some venues book **inline** on the search page (book button in
the DOM, fires `x-tock-*` on load) and some pop a **modal**. This affects both
header capture (passive vs reconstructed) and the reload+click fallback's DOM
selectors. When adding a venue, determine which UI it uses first.

---

## 4. The checkout / price-cap safety model

Both the server's `booker.ts` and the extension's `form-filler.ts` treat the
final purchase as a **fail-closed critical path** — the default when anything is
uncertain is *don't pay*, not *pay anyway*.

- **Grand-total cap, not per-person.** `parseAmountDueCents(text)`
  (`booker.ts`, pure + unit-tested) extracts the **largest** `Amount due $X` on
  the confirm page as cents. It deliberately:
  - requires a literal `$` immediately after "Amount due" (whitespace allowed),
    so a **"Amount due per person $125"** line does **not** match as the total;
  - takes the **largest** match (the grand total is the biggest "Amount due");
  - returns **`null`** when no dollar total is present, and non-numeric text
    (e.g. "Amount due 50% deposit") can never false-match a bogus low number.
- **Fail-closed comparison.** The caller compares the parsed total to the
  configured cap and **aborts the purchase** if the total is `null`
  (unparseable), or exceeds the cap. A missing price is treated as "too
  expensive," never as "free/safe to click."
- **Config gate.** For the sniper, `validateSniperConfig()` refuses to run a
  live-purchase snipe without the required guardrails set — another fail-closed
  gate before a browser is ever warmed. Runs can also be **dry-run / rehearse**
  (labelled as such in history) to exercise the whole path without buying.
- **Reasoned aborts are diagnosable.** `handlePurchaseFlow()` throws
  **diagnosable failures into history** (a price-cap abort, a timeout, an
  unexpected interstitial) so a miss is inspectable from the dashboard rather
  than silent. A **held-but-unpaid** outcome is distinguished from **unbooked**
  in `BookingResult`, and the browser is **frozen for manual recovery**
  (`sessions.ts`) instead of discarded.
- **Payment source of truth is server-side and masked.** `stripe.ts` resolves
  card/billing by priority: non-empty disk override → env vars → `null`
  (nothing to pay with → can't run). The API masks card data on read
  (`GET /api/payment`).

Net: a bug in slot parsing or an unexpected Tock price change results in a
**skipped purchase and a frozen session to review**, not an overpay.

---

## 5. File-by-file index

### Server — engine (`server/src/`)

| File | Responsibility |
|------|----------------|
| `sniper.ts` | **Core sniper engine.** `runSniper` (warm pool → poll → single-winner lock → grab → purchase/rehearse → freeze-on-hold). Types: `SniperConfig`, `SniperResult`, `NormalizedSlot`, `GrabResult`. Tock protocol: `encodeTockLock` (lock protobuf body, `f6`=prepaid price), `lockResponseVerdict` (held/conflict/blocked). Availability parsing: `extractOfferingsFromHtml`, `parseAvailability`. Pure/unit-tested helpers: `pickBestSlot`, `pickFallbackTime12`, `computeWindowOffsets`, `SingleWinnerLock`, `validateSniperConfig`. |
| `booker.ts` | **Single booking + checkout.** `runBooking` (launch → inject cookies → book → close); `runBookingWithContext` (book on a caller-supplied warm context with `AbortSignal`, used by sniper/blitz); `handlePurchaseFlow` (checkout interstitial state machine, throws diagnosable failures into history); `parseAmountDueCents` (price-cap parser, pure/tested). Types `BookingRequest`/`BookingResult`. Shared `STEALTH_ARGS` (anti-detection + container launch flags), `randomDelay`, `to12Hour`. |
| `blitz.ts` | **Parallel blitz mode.** `runBlitz` (warm N browsers, stagger reloads around the drop, run booking on each, single-winner abort, return winner or grouped failure). `BlitzConfig` (attempts clamped 1–5, `staggerMs`), `BlitzResult`, `AttemptOutcome`. Helpers: `summarizeFailures`, `getFingerprint` (deterministic UA+viewport per attempt), `safeShot` (best-effort screenshot). |
| `scheduler.ts` | **In-memory scheduling + history.** `runAt` one-shot (`setTimeout`, 15s early warmup for sniper/blitz) or recurring cron; dispatches to sniper > blitz > single-shot. `schedulerEvents` EventEmitter (`booking-result` for SSE). Types `ScheduledBooking`, `BookingHistoryEntry`, `SniperMeta`, `BlitzMeta`. `startScheduler` (seed from base64 `SCHEDULED_BOOKINGS`), `addScheduledBooking` (idempotent by id), `removeScheduledBooking`, `getScheduledBookings`, history CRUD (`addToHistory` bounded to 50, `getHistory`, `deleteHistoryEntry`, `clearHistory`). **Nothing survives a process restart.** |

### Server — support (`server/src/`)

| File | Responsibility |
|------|----------------|
| `index.ts` | **Express entry point.** Wires all REST/SSE routes + `requireAuth` (Bearer header or `tock_auth` cookie; bypassed when `API_KEY` unset) + sniper-config normalization. Routes: `POST /api/login`, `/api/book`, `/api/blitz`, `/api/sniper`, `GET/POST/DELETE /api/scheduled`, `GET /api/events` (SSE), `/api/history` + screenshot, `/api/sessions/:id/{screenshot,action}`, cookie routes (`/api/cookies`, CORS bookmarklet `/api/cookies/push?key=`, `/api/tock-login`, `/api/tock-credentials`), `GET/POST /api/payment` (masked). Boot: `loadCookiesFromEnv`, `startScheduler`, `startSessionRefresh`, then `app.listen`. |
| `sessions.ts` | **Frozen-session registry + manual recovery.** `freezeSession` (park a won-but-unpurchased browser, return id), `listSessions` (dashboard-safe snapshot, handle omitted, live `ageMs`), `getSession` (full record incl. live handle), `abortSession` (delete-before-close), `applyAction` (re-enter-cvc / retry-purchase / refresh-screenshot / abort on the live page), `sessionScreenshot`. Types `SessionStatus`/`SessionHandle`/`FreezeInput`/`PublicSession`/`SessionAction`; test/TTL seams `_setNow`/`_reset`/`_sweep`. |
| `cookies.ts` | **Tock session cookies.** `TockCookie` (persisted/UI shape, only name+value required), `loadCookiesFromEnv` (disk-first, base64 `TOCK_COOKIES` env fallback, writes seed through to disk), `updateCookies` (full-replace + persist), `getCookies`, `injectCookies` (add to a Playwright context, Tock-safe defaults, returns count; 0 = unauthenticated). |
| `stripe.ts` | **Payment source of truth + Stripe fill.** `PaymentDetails` (card + billing, MM/YY expiry, 2-letter state). `setPaymentOverride` (persist UI card to disk), `getPayment` (priority: non-empty disk override → env → null), `getPaymentFromEnv` (`CARD_*`/`BILLING_*`, needs number+CVC). `fillStripePayment` (card/expiry/CVC into Payment Element iframe), `fillStripeBilling` (name/address/city/state/ZIP into Address Element iframe). |
| `session.ts` | **Keep the login alive.** `saveTockCredentials`/`getTockCredentials` (persist/read raw login), `ensureValidSession` (validate cookies else auto-login — the guard callers run before booking), `startSessionRefresh` (boot ~5s + every-12h keepalive timers). |
| `login.ts` | **Automated sign-in.** `loginToTock(email, password)` drives a real (headed-ish) Chromium login, clears Cloudflare Turnstile, extracts + persists cookies via `updateCookies`. Internal `STEALTH_ARGS`. |
| `store.ts` | **Durable disk persistence.** Single `state.json` on Railway `/data`. `saveToDisk(key, value)` (read-modify-write merge so other keys aren't clobbered), `loadFromDisk(key)` (absent → null). `StoreData` blob: `cookies`, `payment`, `tockCredentials`. Best-effort, fail-soft. |
| `notify.ts` | **Outcome webhook.** `notifyResult()` — fire-and-forget POST of the booking outcome (✅/❌ + structured fields + optional blitz stats) to `NOTIFY_WEBHOOK`; no-op if unset, never throws. |

### Extension — content scripts (`src/content/`)

| File | Responsibility |
|------|----------------|
| `form-filler.ts` | **Tock filler (the big one).** `TockFormFiller` class — one instance = one booking attempt. `fill()`, `tryMultipleDates()`, `handlePurchaseFlow()`. Defensive calendar/date/time DOM heuristics, races to click the time-slot book button, walks the add-ons interstitials, and completes auto-purchase by handing cross-origin Stripe iframe coordinates + card/billing to `localhost:3847` in `handlePurchaseConfirmation()`. |
| `opentable-form-filler.ts` | **OpenTable filler.** `OpenTableFormFiller` — direct DOM mutation of party size/date/time; with auto-submit on, clicks the best-matching availability slot toward checkout. |
| `resy-form-filler.ts` | **Resy filler.** `ResyFormFiller` — drives Resy's Angular venue page. `fillForm()` (wait for slots → click nearest to preferred time → click "Reserve Now"), `tryMultipleDates()` (calendar-walk fallback across desired dates). Reserve button lives in the cross-origin `widgets.resy.com` iframe. |
| `floating-timer.ts` | **Countdown overlay.** `FloatingTimer` (internal, self-instantiates on load) — draggable closed-Shadow-DOM widget, polls the background worker ~1/sec for authoritative timer state, shows countdown then live booking status, forwards cancel requests. Pure view. |
| `index.ts` | **Content entry point.** Picks context by hostname (Resy widget iframe vs. top-level page), detects platform, bridges `chrome.runtime` messages to the right filler. Handlers: `CLICK_RESERVE_BUTTON` (in-iframe Resy click proxy), `AUTO_FILL_FORM` (routes single/multi-date fills). Internal `handleFormFill` (never throws, returns boolean). |

### Extension — background + popup (`src/`)

| File | Responsibility |
|------|----------------|
| `background/index.ts` | **MV3 service worker.** Owns all persistent, popup-independent state. `scheduleTimer`/`cancelTimer`/`getTimerStatus` (backed by `chrome.alarms` + persisted `ActiveTimer`), `handleAlarmTrigger` (drop-time execution → running/completed/failed), `attemptFormFill` (scheduled reload-then-fill), `attemptManualFormFill` ("fill now", no reload/retry), `buildDesiredDatesList` (primary date at index 0), `waitForTabReload` (5s timeout + 150ms hydration buffer). `onMessage` router + `onStartup` alarm recovery. |
| `popup/` | React popup UI (`App.tsx`, `components/` — `DateSelectionCalendar`, `PartySize`, `TimePicker`, `DatePicker`). Where the user configures preferences and starts/cancels a timer. |

### Extension — utils + types (`src/`)

| File | Responsibility |
|------|----------------|
| `utils/messaging.ts` | Typed promise wrappers over Chrome messaging: `sendFillFormMessage`, `sendAutoFillFormMessage`, `sendCancelTimerMessage`, `sendGetTimerStatusMessage`. |
| `utils/storage.ts` | Promisified `chrome.storage`: `DEFAULT_PREFERENCES`, `savePreferences`/`loadPreferences` (sync), `saveActiveTimer`/`loadActiveTimer`/`clearActiveTimer` (device-local). Prefs in sync storage, active timer in local. |
| `utils/platform.ts` | `detectPlatform(url)` (host-substring match → `Platform | null`), `getPlatformDisplayName`. The routing primitive for choosing a filler. |
| `utils/url-builder.ts` | Canonical search URLs from a landing URL + preferences: `buildTockSearchUrl`, `buildTockSearchUrlWithDate`, `isTockSearchUrl`, `buildResySearchUrl`, `buildResySearchUrlWithDate`, `isResyVenueUrl`. |
| `types/index.ts` | Shared shapes across popup/worker/content: `Platform`, `TockPreferences`, `Message` (tagged-union envelope), `ActiveTimer` (scheduled→running→completed/failed/cancelled), `FormElements`, `FormFillerOptions`. |

### Scripts (`scripts/`)

| File | Responsibility |
|------|----------------|
| `cvc-server.js` | **macOS `localhost:3847` HTTP helper.** Fills Tock's cross-origin Stripe/Braintree payment iframes by generating AppleScript that replays real `cliclick` mouse clicks + `System Events` keystrokes at viewport coordinates the extension supplies. `readConfig()` (fallback card/browser/`chromeOffset`, treats `YOUR_CVC_HERE` as unset), `buildStripeFillerScript(config, coords)` (empirical 25%/65%/89% width clicks across the Payment Element row + optional Address Element fill), `buildBraintreeFillerScript(config, coords)` (legacy CVC-only, blind 55%/52% fallback when no coords), `runCardAutomation` (merge request body over config, shell-escape, `osascript`). Loopback-only routes `POST/GET /trigger-cvc`, `GET /health`. |
| `tock-cvc-config.json` | Fallback card config + browser name + `chromeOffset` for `cvc-server.js`. |
| `generate-icons.js` | Build helper (extension icons). |

### Reference HTML fixtures (repo root)

`tock-*.html`, `resy.html`, `opentable-nopa.html` — saved snapshots of real Tock
add-ons / gratuity / order-review / complete-purchase pages (and Resy/OpenTable),
used to reverse-engineer selectors and the checkout price surface. Handy when a
selector breaks: diff against the current live DOM.

---

## Where to start reading

1. `server/src/sniper.ts` header comment + `runSniper` — the whole competitive
   path in one file.
2. `server/src/booker.ts` `handlePurchaseFlow` + `parseAmountDueCents` — the
   shared fail-closed checkout both engines reuse.
3. `src/background/index.ts` + `src/content/form-filler.ts` — the extension's
   drop-timer → fill path, and the `localhost:3847` Stripe handoff.
