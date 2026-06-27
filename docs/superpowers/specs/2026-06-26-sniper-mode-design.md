# Sniper Mode — High-Frequency Drop Capture for Tock

**Status:** Approved design (2026-06-26). Author: brainstormed with the repo owner.
**Scope:** Server (`server/`). New booking engine alongside the existing blitz; no Chrome-extension changes.

## 1. Problem & goal

For ultra-competitive Tock drops (e.g. FHH / `fui-hui-hua-san-francisco`), the current 5-attempt blitz fires reloads at fixed 1-second offsets (−2s…+2s). Diagnosis of the 2026-06-26 8:00 PM run: all 5 attempts returned `No dates available. Found: none` — the calendar *loaded fine* (session OK, no anti-bot block), but inventory either appeared in a gap between the 1-second-spaced attempts, or only inside the release window we under-covered. The owner confirmed: right month (July), and inventory appears within roughly **−1s to +10s** around the drop.

**Goal:** densely cover that ~11-second window and grab a matching slot the instant it appears, then auto-purchase — without OOMing the single Railway box or escalating into detection-evasion.

**Non-goal / boundary:** no proxy rotation, no CAPTCHA/Turnstile solving, no raw-API auth reverse-engineering for evasion. All requests come from the owner's own authenticated browser session doing normal booking actions, just programmatically.

## 2. Why not "hundreds of browsers"

Each headless Chromium is ~150–300 MB + a CPU core under load; one Railway container OOMs at ~5–15. The race is won at the HTTP layer, not the DOM: a full SPA reload+hydrate+parse is seconds, while Tock's availability and cart calls are ~100 ms. So "many more instances" is realized as **many cheap availability checks from a few warmed browsers**, not many browsers. A few hundred read requests in 11 s from one IP is the accepted ceiling; if Cloudflare throttles, we stop rather than evade.

## 3. Architecture (Approach A: in-browser fetch polling)

```
schedule (runAt + window + sniper cfg)
  → T−15s: launch pool (≤6 browsers), inject cookies, warm on the restaurant search page,
            auto-discover the availability (READ) call by sniffing the page's own XHR during warmup
  → window −1s…+10s: each browser polls availability via in-page fetch every ~200 ms,
            offset across browsers so collective coverage is sub-100 ms
  → first matching slot → atomic single-winner lock → GRAB → blind auto-purchase
       ├─ purchase success → record + notify ✅
       └─ purchase failure → FREEZE session (keep browser open) + screenshot + notify ⚠️
  → window ends with no hit → clean failure w/ grouped per-poll reasons (reuses visibility work)
```

New module `server/src/sniper.ts`, reusing helpers from `booker.ts` (`STEALTH_ARGS`, `to12Hour`, `handlePurchaseFlow`, fingerprints from `blitz.ts`) and the per-attempt/screenshot visibility plumbing already added to `blitz.ts`/`scheduler.ts`/`index.ts`.

## 4. Components

### 4.1 Endpoint recon (automatic, at warmup)
During warmup, attach `page.on('request'/'response')` (or `page.route`) to capture the availability XHR the search page fires (URL + query params + response JSON shape). No hardcoded endpoint — adapts if Tock changes. Fallback if it can't be isolated: soft-refresh polling (Approach C) instead of fetch polling.

### 4.2 Poller
Per browser, an in-page `fetch` loop hitting the discovered availability endpoint every ~`pollIntervalMs` (default 200), parsing the response for a slot matching the requested date AND time (with the existing `to12Hour` matching). Loops start at staggered offsets so the pool blankets the window. Each poll's outcome (hit / none / error) is recorded for post-run visibility.

### 4.3 Single-winner lock
An in-process compare-and-set flag. The first poll loop to find a matching slot atomically claims the grab; all other loops stop immediately. **Critical** — without it, multiple pollers could grab/buy duplicate reservations (double-booking, double-charge).

### 4.4 Grab (direct Book-call preferred, DOM-click fallback)
On winning the lock:
- **Preferred:** fire the Book/cart-hold call as an **in-page `fetch`** from the warmed browser, using the offer/slot identifier from the availability response. Browser supplies cookies/headers/CSRF → no auth reverse-engineering, lower detection than a raw server request.
- **Fallback:** if the direct call is rejected or its shape is unknown, click the real Book button in the DOM. This path also folds in the disabled-button fix (wait for the button to be *enabled* / filter `:not([disabled])` instead of hammering a disabled button for 30 s).

The exact Book request (URL, method, payload, which IDs) is captured in **implementation step 1 (recon)**; until then the fallback is the active grab. Offline recon of saved `tock-*.html` pages seeds this; a one-time live capture finalizes it.

### 4.5 Purchase
Blind full-auto: reuse `handlePurchaseFlow` (add-ons → gratuity → consent → saved-card CVC / Stripe → purchase) with `dryRun=false`. No match/price gating (owner's explicit choice). An optional `maxPrice` guard is left as a one-line hook in config, default off.

### 4.6 Failure-recovery console (canned actions)
If purchase fails (returns false / throws / not success), the winning browser is **not closed**. It is registered in a `pausedSessions` map: `{ id, browser, page, restaurant, bookedDate, bookedTime, status, createdAt, lastError }` with a TTL (~10 min, the Tock hold window) after which it auto-closes/releases. New auth'd endpoints:
- `GET /api/sessions` — list frozen sessions (id, restaurant, slot, age, status).
- `GET /api/sessions/:id/screenshot` — fresh live screenshot of the page.
- `POST /api/sessions/:id/action` — canned actions: `re-enter-cvc` (refills CVC + re-attempts), `retry-purchase`, `refresh-screenshot`, `abort` (closes/releases).
Dashboard gains a **"Live Sessions"** panel (screenshot + the four buttons), driven by the existing SSE + screenshot-serving patterns.

## 5. Configuration

New `sniper` config (on the manual `/api/blitz`-style route and on `ScheduledBooking`), reusing `restaurant`, `dates`, `partySize`, `time`, `runAt`:
```ts
sniper?: {
  pool: number;            // browsers, clamped 1..6 (default 5)
  pollIntervalMs: number;  // default 200
  windowStartMs: number;   // offset vs runAt, default -1000
  windowEndMs: number;     // offset vs runAt, default +10000
  maxPrice?: number;       // optional safety cap on amount due (default: unset = blind)
}
```
`runAt` is the ISO drop instant (already timezone-fixed). Warmup begins `runAt − 15s` (existing scheduler early-fire for blitz).

## 6. Error handling & safety

- **Single-winner lock** → no duplicate grab/purchase.
- **Throttling (429 / Cloudflare):** brief per-browser backoff; if all browsers are throttled, record `throttled` and stop. No evasion escalation.
- **No hit by window end:** clean failure with grouped per-poll reasons (reuses `summarizeFailures`).
- **Stale session:** if availability calls 401/redirect to login, fail fast with a clear "session expired — refresh cookies" error (don't silently spin).
- **Memory bounds:** pool ≤ 6; capped paused sessions; capped screenshots; TTL cleanup of frozen browsers; always close non-winning browsers.
- **Money safety:** the freeze-on-failure path means a failed charge never silently retries forever; recovery is human-gated via canned actions. Optional `maxPrice` available.

## 7. Testing

- **Unit:** availability matcher (date+time → slot), single-winner lock under concurrent claims (exactly one winner), window/offset math, `summarizeFailures`.
- **Local integration (no Tock):** a mock availability HTTP server that returns "none" for N ms then flips to a slot; assert the poller catches the transition, exactly one winner grabs, and the timing window is honored.
- **Recovery:** simulate a purchase failure → assert session frozen, `/api/sessions` lists it, screenshot served, each canned action applies to the page, TTL closes it.
- **Manual smoke (when a session exists):** dryRun sniper against a high-availability restaurant to confirm endpoint recon + polling + grab path end-to-end (no real purchase).

## 8. Open items (require the owner / a live session)

1. **Live Book-call recon** — capture the real cart-hold request to finalize the direct-call grab. Blocked on a valid session + a capture surface (Claude-in-Chrome reconnected, or instrumented Playwright with fresh cookies). Until done, the DOM-click fallback is the active grab.
2. **Railway redeploy** — the deployed instance runs old code; sniper goes live only after redeploy.
3. **Session freshness** — Turnstile breaks the server's auto-login; a real drop needs fresh pasted cookies beforehand (see existing known-issues).

## 9. Boundaries / non-goals (restated)

Single Railway box; pool ≤ 6; ~200 ms polling; no proxies; no CAPTCHA/Turnstile solving; no raw-API auth evasion. The owner's own session, own reservation, normal booking actions performed programmatically.
