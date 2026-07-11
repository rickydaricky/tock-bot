# Winning the FHH Drop — Pre-Fired Lock Volley Architecture

**Status:** Implementation-ready design
**Date:** 2026-07-11
**Target:** Fù Huì Huá (`fui-hui-hua-san-francisco`), drops every Friday 8:00:00 PM PDT. Inventory sells out in <1s.
**Next live FHH drop:** Fri **2026-07-17 20:00 PDT**.
**Rehearsal target:** JouJou (`joujousf`), daily 10:00 AM PDT, winnable.
**Author role:** Lead architect synthesis of 4 red-teamed designs.

---

## 0. TL;DR — what changes and why

On 2026-07-10 we lost because our architecture is **poll → detect (~0.5s in-page fetch + parse) → THEN build + PUT the lock**. The slot was taken inside that gap. The winners are not detecting; they fire **pre-built authenticated lock PUTs at the drop instant**.

This spec replaces the poll→lock critical path for FHH with a **T0 Volley Fire** engine: pre-encode the lock protobuf for the small set of *wanted* date×time cells during warm-up, calibrate to Tock's own clock, and at a corrected T0 fire an **in-page** (Chromium-fingerprinted, cf_clearance-bearing) volley of `PUT /api/ticket/group/lock` requests, re-firing across the drop window until one returns HELD. Detection becomes a **side-channel** that (a) reconciles experience-id/price drift and (b) reads the true server-authoritative "populate edge" to correct our fire clock — never a prerequisite to firing.

**Four conflict-resolution decisions that the red-teams forced, stated up front:**

1. **NO raw-Node substrate.** Every design's "raw HTTP is the primary speed lever" was killed by the same red-team finding: `cf_clearance` is bound to the JA3/JA4 TLS fingerprint of the headless Chromium that solved the challenge. A `node:https`/`undici` ClientHello is a different fingerprint → Cloudflare 403/managed-challenge. We stay **100% in-page** (the proven, Cloudflare-passing path), and make it faster by moving the *entire* fire loop into the renderer (one `page.evaluate` that owns the busy-spin AND the fetch burst), so we pay the CDP hop **once at arm time**, not per-PUT. Optional raw path is a **flag-gated experiment**, proven-in-isolation-first, never load-bearing.

2. **NARROW, SERIALIZED CLAIM — not a 91-cell blind fusillade.** Firing ~91 concurrent locks on one session creates: (a) a WAF/anti-abuse signature that can kill our session mid-drop, and (b) a **multi-hold cart-state hazard** — Tock's `/checkout/confirm-purchase` "loads the *current* lock," so holding several slots means checkout renders an ambiguous/last-write slot. We fire only the operator's **1–3 wanted cells** (best-time-first), with a synchronous **at-most-one-in-flight-per-slot** guard, and escalate breadth only after the primary cells conflict. Depth of retries on the slots we want beats breadth across slots we don't.

3. **REACT-TO-POPULATE clock, not predict-the-millisecond.** HTTP `Date` is 1s-resolution and reflects the CDN edge, not Tock's origin lock-window. Real drops have been observed **tens of seconds late** (JouJou +38s). So we treat the computed T0 as a *coarse* window (±500ms), start a **low-rate detection poll at T0−2s**, and the instant offerings **populate** we ignite the claim off that **observed server-authoritative edge**. Millisecond alignment to 8:00:00.000 is optimizing the wrong variable; continuous coverage across the late window is the cheap, robust part.

4. **FHH is FREEZE-FOR-MANUAL BY DESIGN until modal auto-checkout is proven.** Modal checkout-after-API-lock is unsolved for FHH. We ship the volley to maximize **P(win lock)**, instrument P(win lock) and P(complete checkout) **separately**, and on HELD fire an instant **PushNotification/Slack** with a one-click deeplink so a human finishes the modal checkout inside the 10-min hold. We do NOT auto-purchase FHH until modal auto-checkout is demonstrated green on a rehearsal bed. The **price cap is wired into the manual path** as a prerequisite of this spec (it currently is not — see §4.4).

---

## 1. Chosen end-to-end strategy & why it wins a sub-second race

### 1.1 The core mechanism

The grab is *just* an authenticated HTTPS `PUT /api/ticket/group/lock` (cookies + `x-tock-*` headers + protobuf body). It does **not** require detection, a DOM button, or the poll. Therefore:

- **Pre-encode** the lock body for each wanted cell during warm-up (`encodeTockLock`, already pure).
- **Pre-authenticate**: warm a pool of headless Chromium contexts past Cloudflare so each carries a live `cf_clearance` + the user's Tock login cookies; reconstruct the `x-tock-*` header set from page state (FHH is modal → fires 0 passively, `readTockHeadersFromPage` already handles this).
- **Pre-arm the fire loop inside the renderer**: at ~T−3s, inject one long-lived `page.evaluate` per warm page that receives the pre-encoded bodies + headers + a renderer-local fire deadline, and *awaits* ignition.
- **Ignite at the observed drop edge**: react to the offerings-populate edge (server-authoritative), or the coarse computed T0, whichever comes first; then fire the in-page `fetch()` volley and **re-fire** conflicting cells every ~50–80ms across a ~15–30s window.
- **First HELD wins** via a shared `SingleWinnerLock`; all other loops stop.

### 1.2 Why this wins where 2026-07-10 lost

The 2026-07-10 loss was **structural latency**, not bad luck: detect (~0.5s) → serialize → PUT put our first lock on the wire ~500ms+ after we observed availability, and the slot was gone. This design **deletes the detect-then-build gap**: at ignition the *only* operation in flight is the pre-encoded, pre-authenticated lock PUT itself. Because the fire loop lives in the renderer, the request leaves the same JS event loop that owns `cf_clearance` with no CDP round-trip in the hot path. We therefore contend in the **same RTT band as the winners** (who also fire pre-built locks), rather than one poll-cycle behind them — and we keep firing continuously across the late-release window so a drop that lands at T0+12s still gets a fresh in-flight PUT within ~50ms of the release edge.

### 1.3 Honest scope of "win"

"Win" = **HELD lock** (the hard, contested part — a ~10-min hold). Converting HELD → paid reservation on FHH's modal UI is a **separate milestone** that is not yet autonomous. This spec makes the lock reliably winnable and the checkout reliably *recoverable* (auto where proven, human-in-loop within 10 min otherwise), with the fail-closed price cap enforced on **both** paths.

---

## 2. Timing / clock-sync mechanism + firing schedule

### 2.1 Clock model (react-to-populate primary, coarse-calibration secondary)

We do **not** claim sub-100ms clock precision from the `Date` header. Instead, two layers:

**Layer A — Coarse calibration (bounds the window).** New `server/src/clock.ts`:
- `calibrateClock(page)`: from a warm page, issue ~6 in-page `HEAD`/`GET` to `https://www.exploretock.com/`, read the `date` response header, and detect the **second-rollover edge** (spin requests straddling a second boundary; the instant the header ticks pins server-second phase to ~±150–300ms). Bracket each sample with `performance.now()` before/after to bound RTT; keep **min RTT** as the uncongested floor.
- Cross-check against a public **NTP/HTTP-time** sample if egress allows; if NTP is blocked on Railway, rely on the Date-edge + the origin cross-check below.
- Returns `{ offsetMs, confidenceMs, minRttMs }`. `t0Local(dropIso, offset)` computes the local epoch for 03:00:00.000Z (8:00 PDT, DST-correct via `Intl.DateTimeFormat` parts — NOT a hardcoded offset; the recent "Fix timezone handling" commit shows raw `runAt` TZ bugs are real).
- **Refuse to arm** (loud alert, fail-closed) if `confidenceMs` is worse than ±500ms OR the computed fire epoch does not correspond to 03:00:00.000Z within tolerance.

**Layer B — React-to-populate (the authoritative ignition).** Starting at **T0−2s**, one warm page runs a **low-rate detection poll** (`fetchOfferingsFast`, existing) every ~150–250ms watching for the target week's offerings grid to **populate** (transition from empty/SOLD to bookable). The **instant it populates, that is the true T0** — ignite the claim volley off *that observed edge* on all warm pages. This converts "predict the millisecond" into "react to the observed populate," which is both more accurate than any Date-header math and immune to the late-release problem.

**Fire trigger = `min(computed-T0-window-open, observed-populate-edge)`**, then sustained re-fire. Firing a hair early is free (early PUTs return conflict/not-yet-open and simply retry); firing late loses.

### 2.2 Firing schedule (concrete numbers)

| Phase | Time (relative to nominal 8:00:00.000 PDT) | Action |
|---|---|---|
| Warm | T−120s | Launch pool (6), inject cookies, goto search page with existing warm-retry until `window.store`/`tock_session` present; capture/reconstruct `x-tock-*`. |
| Calibrate | T−30s | `calibrateClock` on freshest warm page → offset/confidence. Hard-gate arm if confidence >±500ms. |
| Reconcile | T−3s | ONE offerings fetch on the **currently-bookable** week to read live experienceId/f6/openTime; reconcile vs FHH constants (§3.3). |
| Header freeze | T−2s | Freeze the `x-tock-*` set (re-read once as freshness check); refuse to arm loudly if null. |
| Arm renderer | T−2s | Inject the long-lived `page.evaluate` fire loop on every warm page (bodies + headers + renderer deadline in). Loops `await` ignition. |
| Detect edge | T−2s → T0 | Low-rate populate poll (~150–250ms). |
| **Ignite** | **observed populate edge, else computed T0−120ms** | Renderer busy-spins the final <5ms in `performance.now()`, then fires the wanted-cell volley. |
| Sustain | T0 → T0+**30s** | Re-fire conflicting cells every **~50–80ms** per page; escalate breadth (backup times/dates) only after primaries conflict for ~200ms. |
| Deadline | T0+30s | Stop the barrage; hand any HELD to checkout, else record miss + `seen` diagnostics. |
| Cancellation net | T0+30s → hours (optional, flag) | Slow re-fire (~1 fire / 2s) to catch a released cancellation. |

**Pre-fire RTT offset:** ignite at `edge − minRttMs` so the packet *arrives* at the origin at the open instant. Do NOT over-optimize the send lead — the sustained re-fire window is what actually catches the drop.

**Volley cadence rationale:** ~50–80ms re-fire × ~1–3 wanted cells × 6 pages ≈ a bounded, WAF-safe aggregate (see §5), not the ~300+ req/s blind fusillade the red-teams flagged as self-inflicted denial.

---

## 3. Headers / cookies / cf_clearance / experience-id / price staging

### 3.1 cf_clearance + login cookies (in-page only)

- Each warm context establishes its own `cf_clearance` during warm-up (independent per browser → a challenge on one page doesn't sink the run).
- The lock fetch runs **in-page with `credentials:'include'`**, so it automatically rides that context's `cf_clearance` + Tock login cookies. **No cookie serialization, no raw socket** (avoids the JA3 mismatch that kills replayed clearance).
- **Refresh guard:** during the pre-drop hold, if a warm page's populate poll returns a challenge, re-warm that page (idempotent) rather than letting it fire authless.

### 3.2 x-tock-* headers

- Capture passively via `captureTockHeaders` where available; for FHH (modal, fires 0 passively) reconstruct via `readTockHeadersFromPage` (session from `sessionStorage['tock_session']`, fingerprint from `localStorage['fingerprint']`, businessId/build/experiments from embedded state — already byte-verified).
- **Freshness hard-gate at T−2s:** if `readTockHeadersFromPage` returns null on a modal venue, **abort loudly and page the operator** before the drop. Never fire authless locks that all 401 and burn the window silently.
- Add an integration assertion (rehearsal) that the reconstructed header set actually returns **HELD** on a live JouJou lock — not merely non-null — so a wrong-header run isn't misdiagnosed as "out-sped."

### 3.3 Experience-id / price drift handling (the dead-body wipeout risk)

FHH's experienceId (559289) and f6 (25800 = $258/pp) **can change per menu/season**. A wrong f6 yields a 200 "no longer available" that `lockResponseVerdict` classifies as `conflict` — so a whole volley of wrong-price bodies looks like "out-sped" while the slot is actually open. Mitigations, layered:

1. **T−3s reconcile on the currently-bookable week.** Next week's offerings are EMPTY until 8:00:00.000, so we read the experienceId/f6 from the **current** live week and assume continuity. If current-week experienceId ≠ 559289 or price ≠ 25800, **alert loudly (Slack) and require operator confirmation** before firing hardcoded bodies.
2. **Small f6 fan for the primary cell.** Fire the primary wanted cell with the known-good f6 **plus** a couple of plausible season price points (e.g. 25800, 29500) — as a *low-priority secondary wave*, never letting a speculative price win over the intended one, and never on the manual-checkout path without the cap (§4.4).
3. **First-30ms detection burst reads the ACTUAL released experience/price.** Immediately after ignition, one page reads the just-populated offerings and, if the released experienceId/f6 differs, **rebuilds bodies live** and injects them into the barrage (accepting a ~30–50ms cost only for the drift case). This is the one place we accept a one-poll latency — to eliminate the dead-body wipeout.
4. **Fail-open pruning.** Extend `lockResponseVerdict` classification: a response that does NOT match the known ~89-byte "no longer available" shape but still isn't a valid ≥150B lock is a **new `rejected`/ambiguous verdict** (rate-limit, lock-state, wrong-f6) — **keep retrying** it and **log the raw body verbatim**, rather than pruning a possibly-winnable candidate. Only the confirmed conflict shape prunes a cell.

---

## 4. Single-winner + cleanup + modal checkout + fail-closed price cap

### 4.1 Single-winner + at-most-one-hold guarantee

- Reuse `SingleWinnerLock` (sync in-memory mutex; all fire loops share one process/event loop — **no worker_threads**, so the mutex genuinely governs every path).
- **Synchronous claim gate:** before a fire loop resolves a HELD to checkout, it calls `SingleWinnerLock.tryAcquire()`. The first acquirer wins; every other loop stops.
- **Never hold multiple slots:** fire **at most one in-flight PUT per (date,time24,experienceId) cell**, and start with 1–3 wanted cells (best-time-first), not the full grid. Because a session's cart holds ONE "current lock" (last-write-wins), holding several is both a cart-ambiguity bug and an anti-abuse signal. If we must widen for coverage, widen across **dates** (one in-flight per date) before adjacent times.

### 4.2 Held-slot attribution (cart-slot vs winner-slot reconciliation)

Because `/checkout/confirm-purchase` "loads the *current* lock," we must not trust that it shows the cell we think we won:

- **Parse the returned lock protobuf** (a real ~1200B lock echoes reservation date/time/experience) and assert it matches the winning cell's `{date, time24, experienceId}` before proceeding — a 4th verdict outcome `held-mismatch` rejects a HELD whose echoed cell doesn't match.
- **Extend the wrong-slot guard** (`grabViaApi` line 749) from date-only (`includes(wantDate)`) to also assert the **12h time string** and, where readable, the experience/menu name. FHH's whole grid is same-date/same-price, so a time mismatch currently sails through the cap — this closes that hole.

### 4.3 Cleanup of extra holds

- The codebase has **no lock-release primitive today**. Because we fire at most one in-flight per cell and serialize the claim, multi-hold should not occur — but as defense in depth, **reverse-engineer Tock's release/abandon call** (the app fires one when you back out of checkout; capture it on a rehearsal) and, if more than one cell ever returns HELD, fire release for the extras. **Gate:** validate the multi-hold scenario on JouJou (deliberately let two cells race; confirm whether Tock grants two holds and whether release frees them) before trusting the volley at FHH.

### 4.4 Fail-closed price cap — on BOTH paths (prerequisite fix)

- **Auto path (unchanged, proven):** on reaching a checkout page, `handlePurchaseFlow(page, dryRun, screenshots, maxPriceCents)` reads the real grand-total via `parseAmountDueCents` and **fail-closes** (abort if over cap or unreadable). Untouched.
- **Manual/freeze path (BUG — must fix before FHH):** `sessions.ts` `applyAction('retry-purchase')` currently calls `handlePurchaseFlow(page, false, [])` with **no `maxPriceCents`** — the overspend guard is silently absent on the exact path FHH will land on. **Required change:** store `maxPriceCents` on the frozen session in `freezeSession()` and pass it through `applyAction`. Until this ships, freeze-for-manual is an unguarded-spend path and must not be the plan for a $258×2 reservation.
- **Speculative price fan never bypasses the cap:** any f6-fan candidate that lands HELD still goes through the same Amount-due cap + attribution guard; a frozen session stamped with a *guessed* price surfaces a **RED "GUESSED PRICE — verify $X"** banner on the dashboard.

### 4.5 Modal checkout-after-lock (the true bottleneck)

FHH is modal: a bare `goto /checkout/confirm-purchase` may redirect (paid client-flow venues need the client Book action). Tiered, honest:

1. **Tier 1 — API-replicated checkout (to be reverse-engineered on a rehearsal):** capture the app's post-lock cart/checkout API calls (widen `captureTockHeaders` to log post-lock request URLs/bodies) and **replay them programmatically** to reach a page that renders "Amount due $". This is the only true auto-checkout for modal; it must be demonstrated end-to-end on a modal bed **before** relying on it.
2. **Tier 2 — in-page modal re-render + click:** after HELD, drive the venue's own modal via `evaluate` (not a full navigation, which redraws Turnstile on the Railway IP). Speculative; only if Tier 1 unavailable.
3. **Tier 3 — freeze-for-manual (the FHH default until Tier 1 is green):** `freezeSession()` parks the winning live browser (slot held ~10 min) with reason + screenshot + stored `maxPriceCents`, fire an instant **PushNotification/Slack** with a one-click deeplink to the dashboard Live Sessions panel. Human completes checkout in <10 min under the cap.

**Decision:** ship FHH as **Tier 3 by design** with an operator staffed 7:59–8:10pm, and treat Tier 1/2 as parallel work that flips FHH to auto only after a green modal-checkout rehearsal.

---

## 5. Anti-bot / rate-limit / IP realities & avoiding self-inflicted blocks

**Reality:** all warm contexts share ONE Railway egress IP. Per-IP Cloudflare rate limits and Tock per-account rules apply to the **sum** of all substrates. The 2026-07-10 warm-up saw **0 Cloudflare challenges precisely because it was low volume**. A blind ~300+ PUT/s fusillade inverts that and is the single most likely way to lose (soft-ban mid-drop invalidates cf_clearance during the one second that matters).

**Rules:**

1. **Bounded aggregate rate.** Cap per-page in-flight to ~4–6 and re-fire to ~50–80ms; with 1–3 wanted cells across 6 pages the aggregate stays far below any blind-fusillade rate. Tune the exact ceiling on JouJou and **measure whether cf_clearance survives the burst before trusting it at FHH.**
2. **Partition, don't pile.** Each of the 6 pages owns a **disjoint** subset of cells (no cell fired by two pages) → 6 distinct `__cf_bm`/session fingerprints spread the signature instead of concentrating it.
3. **No pre-T0 conflict-storm.** Do not blind-fire before the populate edge; the react-to-populate ignition means we start hammering *when inventory exists*, not seconds before, so we don't train the WAF on our fingerprint ahead of the legit spike.
4. **Session-health circuit breaker.** If >N consecutive verdicts flip to `blocked` at T0 (WAF/session kill), **immediately stop the burst**, drop to a single low-rate in-page path, and **alert**. Keep 1–2 pages in reserve at gentle cadence so a throttle on the aggressive pages doesn't zero coverage. Turnstile already breaks this account's re-login (session goes stale 403, can't self-repair) — protect the session over blanket coverage.
5. **Pre-stage a fallback context.** Warm a second login/cookie set if available so a mid-drop session kill has a fallback. (If not available, the circuit breaker at least fails loud, not silent.)
6. **Deploy freeze.** No Railway deploys within ~2h of 8pm Friday (in-memory schedule wipes warm pool + calibration on deploy). Add a **boot-time self-test** that re-warms + re-calibrates + re-primes and **refuses to arm** if any of {cookies valid, headers reconstructable, cf_clearance present, clock confidence ≤±500ms} fails.

---

## 6. Concrete implementation plan (mapped to existing files, ordered)

Existing anchors confirmed in code: `encodeTockLock` (sniper.ts:656), `lockResponseVerdict` (:679), `grabViaApi` (:695, checkout tail :736–762, wrong-slot guard :749), `readTockHeadersFromPage` (:332), `captureTockHeaders` (:317), `fetchOfferingsFast` (:449), `extractOfferingsFromHtml` (:421), `SingleWinnerLock` (:148), `validateSniperConfig` (:257), `SniperConfig` (:234), `experiencePriceCents` (:189), `freezeSession` import (:43), `handlePurchaseFlow` import from booker (:40). Scheduler earlyMs `15_000` (scheduler.ts:254).

**Task 1 — `server/src/clock.ts` (NEW).**
`calibrateClock(page)` → `{ offsetMs, confidenceMs, minRttMs }` via in-page Date-edge spin + min-RTT; `t0Local(dropIso, offsetMs)` DST-correct via `Intl`; pure `computeFireAt(edgeMs, minRttMs, leadMs)`. Unit-test: second-boundary parse, fireAt math, PDT/PST boundary.

**Task 2 — candidate builder in `sniper.ts`.**
`buildCandidateBodies(req, constants)` → `Array<{ key, date, time24, experienceId, f6, b64 }>` = **wanted** cells (operator target date(s) × in-window times, best-first) × primary (expId,f6) with an optional low-priority f6-fan. Reuse `encodeTockLock`. Unit-test: count/shape, byte-match vs a captured real lock, priority ordering (backup date can never win over primary).

**Task 3 — pre-drop reconcile in `sniper.ts`.**
`preDropRecon(page, req)` at T−3s: one `fetchOfferingsFast` + `extractOfferingsFromHtml` on the current week → live experienceId/f6/openTime; fall back to FHH constants when empty/SOLD; **alert if current-week values differ from 559289/25800**.

**Task 4 — renderer fire loop in `sniper.ts`.**
`fireVolley(page, candidates, headers, ignitionSignal, reFireMs, deadlineMs)`: ONE long-lived `page.evaluate` armed at T−2s that (a) `await`s ignition, (b) busy-spins the final <5ms in `performance.now()`, (c) fires the wanted cells as a bounded-concurrency (~4–6) `fetch('/api/ticket/group/lock',{method:'PUT',credentials:'include',...})` burst, (d) classifies inline with **ported** `lockResponseVerdict` + the new `held-mismatch`/`rejected` outcomes, (e) re-fires non-held cells every `reFireMs` until HELD or `deadlineMs`, (f) resolves `{held, date, time24, experienceId, bodyLen, echoedCell}`. The busy-spin and the fetch are in the **same renderer process** — no CDP hop in the hot path.

**Task 5 — verdict extension in `sniper.ts`.**
Extend `lockResponseVerdict` (or add `classifyLock`) with `held-mismatch` (real lock but echoed cell ≠ intended) and `rejected` (ambiguous non-conflict rejection → keep retrying, log raw body). Keep the confirmed ~89-byte "no longer available" as the only pruning `conflict`.

**Task 6 — react-to-populate detector in `sniper.ts`.**
`watchPopulateEdge(page, req, deadlineMs)`: low-rate `fetchOfferingsFast` poll from T0−2s; resolve the instant the target week populates → drives `ignitionSignal`. Runs concurrently as the authoritative T0.

**Task 7 — `runSniper` volley mode in `sniper.ts`.**
Behind `cfg.volleyFire` (default ON for FHH; legacy poll path preserved when false): warm pool (unchanged) → `calibrateClock` (hard-gate confidence) → `preDropRecon` → freeze headers (hard-gate non-null) → arm `fireVolley` on all pages + `watchPopulateEdge` → ignite off `min(computed window-open, populate edge)` under `SingleWinnerLock` → first HELD → **attribution guard** → existing `grabViaApi` checkout tail + `handlePurchaseFlow(maxPriceCents)` → **freeze fallback with stored cap**. First-30ms drift burst rebuilds bodies if released expId/f6 differs.

**Task 8 — `SniperConfig` + `validateSniperConfig` in `sniper.ts`.**
Add `volleyFire?: boolean; wantedTimes24?: string[]; wantedDates?: string[]; fireLeadMs?: number; reFireMs?: number; volleyDeadlineMs?: number; fixedExperienceId?: number; fixedPrepaidCents?: number; f6Candidates?: number[]`. `validateSniperConfig` still requires `maxPriceCents` unless `dryRun`; bound the new numeric fields.

**Task 9 — checkout attribution in `sniper.ts` (`grabViaApi`) / `booker.ts`.**
Extend the wrong-slot guard to assert **date AND 12h time** (and experience name if readable). `booker.ts` `handlePurchaseFlow`/`parseAmountDueCents` unchanged.

**Task 10 — price cap on the manual path in `sessions.ts` (REQUIRED before FHH).**
Store `maxPriceCents` in `freezeSession()`; change `applyAction('retry-purchase')` to `handlePurchaseFlow(page, false, [], session.maxPriceCents)`. Add the RED guessed-price banner field.

**Task 11 — notify on HELD in `notify.ts` + PushNotification wiring.**
On the first HELD, fire a high-urgency Slack/PushNotification with a one-click dashboard deeplink so a human can finish the modal checkout inside 10 min.

**Task 12 — scheduler wiring in `scheduler.ts` + `index.ts`.**
Bump sniper `earlyMs` from `15_000` to **~120_000** (config-driven) so warm + calibrate + reconcile + arm complete before T0. Keep passing the original `runAt`; the engine computes the true drop instant + lead itself. `index.ts` sniper-config normalization passes the new fields through. Add the boot-time arm self-test.

**Task 13 — (OPTIONAL, flag-gated experiment) raw-Node probe.**
Before ANY raw substrate ships: from the Railway host, harvest `cf_clearance` from a warm context and fire a **single** authenticated GET over `node:https`. If it returns Cloudflare HTML/403, **delete the raw path**. If a fast non-browser path is ever wanted, use a TLS-impersonating client (curl-impersonate / BoringSSL JA3-mimic), re-test clearance acceptance, and keep it strictly additive behind a default-off flag.

**Task 14 — tests + build.**
Unit: candidate cross-product/priority, clock rollover-edge + fireAt, verdict classification (held/conflict/held-mismatch/rejected), single-winner across volleys (mock fetch, first-HELD acquires + cancels rest), attribution guard rejects mismatched echo. Run `npm run build` + `node --test` on **Node 20** (per known-issues).

---

## 7. Rehearsal plan on JouJou (winnable, daily 10am PDT) — the gate before FHH

JouJou validates plumbing but is **not** identical to FHH (JouJou is multi-seating → needs `f13` seatingAreaId, non-strict-price, abundant inventory). It cannot de-risk strict-price blind-fire or modal auto-checkout, but it MUST prove timing/mechanism. Run **multiple days, measured, not dryRun-only.**

**R1 — Calibration accuracy (dryRun).** Run `calibrateClock` + `watchPopulateEdge` at JouJou 10am. Log: computed-T0 vs observed-populate-edge delta, `confidenceMs`, `minRttMs`. Confirm the react-to-populate edge fires.

**R2 — Fire + first-HELD (real, small cap).** Run `volleyFire` with a real (low) cap. **Instrument and record:** wall-clock delta from ignition to (a) first PUT wire-time and (b) first HELD verdict; how many JouJou slots we actually win vs the field over several days. **Gate:** if we cannot reliably HELD a JouJou slot at 10am with this engine, we will not win FHH — do not point at FHH.

**R3 — Idempotency / multi-hold (real).** Fire two locks for the same slot ~25ms apart; record both verdicts and whether the hold survives. Fire two *different* slots in one session; inspect what `/checkout/confirm-purchase` renders. If a self re-lock ever returns conflict or drops the hold, **disable per-cell re-fire on already-HELD cells and dual-path on the same key**. If Tock grants two holds, prove the **release** call frees them. Gate FHH go-live on this evidence.

**R4 — Anti-abuse ceiling (real).** A/B burst sizes / re-fire cadence watching for 429 / Turnstile / cookie-invalidation. Find the rate at which cf_clearance survives; set the FHH ceiling below it.

**R5 — Modal checkout-after-lock (real, on a modal bed).** On JouJou (or n/naka), actually complete an API-lock → checkout → purchase end-to-end under a small cap **without a search-page reload**. If it can't be done, FHH is **freeze-for-manual by design** and we staff a human 7:59–8:10pm with the cap-fix (Task 10) shipped and the frozen-session dashboard pre-opened.

**R6 — Header validity.** Assert the reconstructed `x-tock-*` set returns **HELD** on a live JouJou lock (not merely non-null).

**Ops before FHH 2026-07-17:** re-arm the FHH job AFTER the final pre-drop deploy; confirm it's the SOLE job (no double-purchase race); re-verify cookies authenticate (capped dry-run → success); freeze deploys ~2h before 8pm; boot self-test green.

---

## 8. Honest overall confidence & biggest residual risks

**Overall confidence: ~40%** that we obtain a **HELD FHH lock** on 2026-07-17, conditional on the JouJou rehearsals (R2/R3/R4) passing. **Confidence of a fully autonomous, unattended paid $258×2 booking: ~15%** on 2026-07-17 (modal auto-checkout unproven → freeze-for-manual is the realistic outcome). With a human staffed 7:59–8:10pm and the manual-path cap fix shipped, **confidence of a completed booking given a HELD lock: ~75%** (human finishes modal checkout inside the 10-min hold).

This is a deliberate re-frame from the four source designs' 55–62% self-confidence (adversarially re-rated 18–32%): we buy realism by (a) killing the unproven raw-Node speed thesis, (b) narrowing to a serialized claim to avoid self-inflicted WAF/multi-hold, (c) reacting to the server populate edge instead of betting on Date-header precision, and (d) treating checkout as a separately-measured milestone with a human backstop.

**Biggest residual risks, ranked:**
1. **Network-distance disadvantage.** Even a perfect pre-fired in-page volley from Railway (tens of ms RTT to Tock's origin) may be structurally behind a competitor firing from a colo box 5–20ms away. Pre-firing removes the detect gap but not the base RTT gap. *Partial mitigation:* also fire from the user's real local logged-in browser/extension at T0 (diversifies egress + shrinks RTT) — future work.
2. **Session kill mid-drop.** A WAF trip or Turnstile-stale-session at T0+200ms loses everything and can't self-repair. *Mitigation:* bounded rate, circuit breaker, reserve pages, pre-staged second context, alert.
3. **Price/experience drift wipeout.** A season menu/price change not in our candidate set makes every lock look like conflict. *Mitigation:* T−3s reconcile + first-30ms drift burst + fail-open `rejected` verdict + loud pre-drop alert.
4. **Modal checkout unsolved.** A HELD lock that can't auto-reach the paid page. *Mitigation:* Tier-1 replay reverse-engineering (parallel work), else freeze + human ≤10 min.
5. **Clock/late-release miss.** *Mitigation:* react-to-populate edge + 30s sustained window makes a +12s or +38s late release still catchable.

**Bottom line:** ship the in-page T0 volley to reliably **win the lock**, prove every FHH-specific assumption on JouJou first, wire the price cap onto the manual path, and treat the modal checkout as a human-in-the-loop step until it's demonstrated green.
