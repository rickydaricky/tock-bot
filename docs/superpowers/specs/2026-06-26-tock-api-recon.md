# Tock API Recon (offline, 2026-06-26)

Reverse-engineered from saved Tock pages (`tock-*.html`: Noma, Restaurant Naides, Jungsik) cross-checked against this repo's working code. **Offline only** — the exact availability/lock endpoints and the live availability response schema are NOT in the saved pages; they require one live capture (checklist in §6). This doc seeds `sniper.ts` and the live-recon step.

## 1. Availability (READ)

- REST base **`https://www.exploretock.com/api`**, namespace **`/api/consumer/...`** — HIGH confidence: the repo's `server/src/session.ts` already calls `https://www.exploretock.com/api/consumer/patron/profile` with cookie auth and treats 200 as authenticated. **Cookie auth is proven**; a same-origin in-page `fetch` from an exploretock.com tab sends the session cookies automatically.
- Exact availability path: **UNCONFIRMED** (unsaved webpack chunks). Feature flag `API_V2_CONSUMER_SEARCH_SA=true` → a v2 consumer-search path is live.
- Search **page** URL (HIGH, the repo builds it): `https://www.exploretock.com/{postName}/search?date=YYYY-MM-DD&size={int}&time={HH:MM url-encoded}` — business-local timezone.
- Response lands in Redux `availability.result` — **empty in all SSR snapshots, so the live slot schema is UNCONFIRMED** (capture live). Offering catalog is in `calendar.offerings.experience[]`: `{id (int, e.g. 546579), state AVAILABLE|LOCKED, partySize[], openDate[], openTime[], price...amountCents}`. Gated experiences carry `calendar.ticketTypeAccessToken`.

## 2. Book / cart-hold (WRITE)

- **LOCK(hold)→PURCHASE** model. Book populates Redux `lock.currentLock` + `lock.lockedUntilMs`; **hold = 10 min** (`business.lockDurationMinutes=10`, on-page `data-testid="holding-time"`).
- DOM trigger: `data-testid="booking-card-button"` (newer/repo) or `offering-book-button_{Name}` (older). Existing `form-filler.ts`/`booker.ts` already query both.
- Endpoint path/method/body: **UNCONFIRMED** (chunked). Inferred body: `businessId`/`postName`, offering `id`, `date`, `time`, `partySize`, maybe `ticketTypeAccessToken`, **maybe a Cloudflare Turnstile token** (site key `0x4AAAAAAAJHWaWliqwIW5o3`, configured app-wide). Turnstile on the lock call is the single biggest risk to a headless direct-call grab.

## 3. Checkout / purchase (browser-bound)

Route sequence: `/{postName}/checkout/options` (add-ons) → gratuity → `/{postName}/checkout/confirm-purchase`. Card fields are **cross-origin Stripe/Braintree iframes** → purchase must go through a browser (no clean API replay). Confirmed testids vs repo: `gratuity-button-zero` ✓, `purchase-button` ✓, consents ✓. `supplement-group-confirm-button` not in saved HTML (only `supplement-page-view-order`) — existing `handlePurchaseFlow` already handles both.

## 4. Identifiers

Canonical offering id = `offerings.experience[].id` (int). Party size = URL `size`. Date `YYYY-MM-DD`, time `HH:MM` 24h, business-local. No epoch encoding in saved state (live slot id may use one — UNCONFIRMED). Examples: Jungsik `businessId 9527`, offering `546579` (Main Dining Room, AVAILABLE) — a good live-recon target.

## 5. Feasibility verdict

- **Direct availability polling: feasible now** (cookie auth + known params; confirm the path live during warmup by sniffing the XHR).
- **Direct Book (lock) call: uncertain** — viable only if Turnstile isn't enforced server-side on the lock endpoint and no opaque server-issued slot id is required. Both unknown.
- **Therefore the reliable grab = browser DOM-click** (Turnstile already satisfied by the live page) after a single reload-on-hit; the direct lock-call is a best-effort optimization pending the live capture. **Purchase always via the browser iframe** (`handlePurchaseFlow`).
- Lowest-risk first increment = **poll availability via in-page fetch (fast detect) → on hit, reload once → DOM-click Book → `handlePurchaseFlow`.** This still fixes the timing problem (precise detection instead of blind reloads) without betting on the direct call.

## 6. Live-recon checklist (do when a valid session exists)

Run against a live **AVAILABLE** offering (e.g. Jungsik `9527`/`546579`) via claude-in-chrome `read_network_requests` through search → Book → checkout:
1. **Availability XHR** — capture the `/api/...` request that fills `availability.result`: exact path, query/body keys, and the full `availability.result` JSON (slot ids, any epoch, ticketType ids, offering linkage). → finalizes `parseAvailability`.
2. **Lock POST** — click Book, capture the POST that sets `lock.currentLock`: path, method, **body** (slot id from step 1? `ticketTypeAccessToken`? `cf-turnstile-response`?), response, and headers (`Authorization`, `x-csrf`, Turnstile). → decides direct-call grab feasibility.
3. **Turnstile check** — grep lock+purchase headers/body for `turnstile`/`cf-`/`token`.
4. **Add-ons/gratuity** — confirm `supplement-group-confirm-button` exists live.
5. **Purchase POST** — capture final purchase body + how the Stripe/Braintree token is attached.
6. **Auth** — diff requests with/without cookies to confirm cookie sufficiency vs any JWT bearer.
7. **Chunk fallback (no browser)** — fetch `https://www.exploretock.com/static/{BUILD}/explore.js` + `*.chunk.js` (build pin `2026-01-14RC10-00`) and grep for `API_BASE`/`lock`/`availability`/`purchase`/`/consumer/`. Version-pinned; 404s after redeploy.
