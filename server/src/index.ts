/**
 * HTTP entry point for the headless booking/sniper server (deployed on Railway).
 *
 * Single responsibility: wire the Express app — define every REST route, the SSE
 * event stream, the auth middleware, and the sniper-config normalization/validation
 * that guards scheduled and manual snipe requests — then boot the scheduler, session
 * refresh, and cookie loading before listening.
 *
 * This module is the thin transport/glue layer: all real work lives in the imported
 * engines (`booker`, `blitz`, `sniper`, `scheduler`, `sessions`, `login`, `session`)
 * and state stores (`cookies`, `stripe`). Route handlers validate input, delegate,
 * record to booking history, fan out notifications, and shape JSON responses.
 *
 * Key surfaces (no named exports — this file runs `app.listen` as a side effect):
 *   - Auth: `requireAuth` (Bearer token OR `tock_auth` cookie), `POST /api/login`.
 *   - Booking: `POST /api/book` (+ legacy `/book`), `POST /api/blitz`, `POST /api/sniper`.
 *   - Scheduling: `GET/POST/DELETE /api/scheduled` (runAt one-shot or cron recurring).
 *   - History: `GET/DELETE /api/history`, screenshot fetch, `GET /api/events` (SSE).
 *   - Sessions: `GET /api/sessions`, screenshot, `POST .../action` (frozen recovery).
 *   - Cookies: `POST /api/cookies`, CORS bookmarklet `POST /api/cookies/push`, tock-login.
 *   - Payment: `GET/POST /api/payment` (masked on read).
 */
import express from 'express';
import path from 'path';
import crypto from 'crypto';
import { runBooking, BookingRequest } from './booker';
import { runBlitz, BlitzConfig } from './blitz';
import { runSniper, SniperConfig, validateSniperConfig } from './sniper';
import { listSessions, sessionScreenshot, applyAction } from './sessions';
import { loadCookiesFromEnv, updateCookies, getCookies } from './cookies';
import { startScheduler, addScheduledBooking, removeScheduledBooking, getScheduledBookings, getHistory, addToHistory, deleteHistoryEntry, clearHistory, ScheduledBooking, schedulerEvents, BookingHistoryEntry } from './scheduler';
import { getPayment, setPaymentOverride, PaymentDetails } from './stripe';
import { notifyResult } from './notify';
import { loginToTock } from './login';
import { saveTockCredentials, getTockCredentials, startSessionRefresh } from './session';

const app = express();
// 5mb ceiling accommodates cookie dumps and base64 screenshots posted back in bodies.
app.use(express.json({ limit: '5mb' }));

// Single shared secret for the whole server. When unset, auth is fully disabled
// (see requireAuth) — intended only for local/dev; production always sets API_KEY.
const API_KEY = process.env.API_KEY;

// Payment override is now managed in stripe.ts via setPaymentOverride/getPayment

// --- Auth middleware ---

/**
 * Gate for every protected route. Accepts the shared API_KEY via either transport:
 *   - `Authorization: Bearer <key>` — used by programmatic API clients / the extension.
 *   - a `tock_auth=<key>` cookie — used by the browser dashboard, which sets the cookie
 *     after POST /api/login so subsequent same-origin fetches authenticate implicitly.
 * If API_KEY is unset the check is bypassed entirely (open server, dev only).
 */
function requireAuth(req: express.Request, res: express.Response, next: express.NextFunction): void {
  if (!API_KEY) { next(); return; }

  // Check Bearer token (API calls)
  const auth = req.headers.authorization;
  if (auth === `Bearer ${API_KEY}`) { next(); return; }

  // Check cookie (web UI)
  const cookie = req.headers.cookie?.split(';').map(c => c.trim()).find(c => c.startsWith('tock_auth='));
  if (cookie && cookie.split('=')[1] === API_KEY) { next(); return; }

  res.status(401).json({ error: 'Unauthorized' });
}

// --- Static UI ---

// Dashboard assets are copied into dist/public at build time and served unauthenticated
// (the login page itself must load before a cookie exists); data routes stay gated.
app.use('/ui', express.static(path.join(__dirname, 'public')));

/**
 * Password check for the dashboard login form. Deliberately unauthenticated — this is
 * where the browser obtains the credential. Returns success when the posted password
 * matches API_KEY (or when auth is disabled); the client then persists it as the
 * `tock_auth` cookie that requireAuth accepts.
 */
// Login page (no auth required)
app.post('/api/login', (req, res) => {
  const { password } = req.body;
  if (!API_KEY || password === API_KEY) {
    res.json({ success: true });
  } else {
    res.status(401).json({ error: 'Wrong password' });
  }
});

// --- Health ---

/**
 * Liveness + readiness probe (unauthenticated). Surfaces whether the two prerequisites
 * for a real booking are in place: a loaded Tock session (cookies) and a configured card.
 */
app.get('/health', (_req, res) => {
  const cookies = getCookies();
  const payment = getPayment();
  res.json({
    status: 'ok',
    cookiesLoaded: cookies.length > 0,
    cookieCount: cookies.length,
    paymentConfigured: !!payment?.cardNumber,
  });
});

// --- Booking ---

/**
 * Single-shot manual booking. Validates the required fields, runs the full booker
 * (search → hold → optional auto-purchase), fires a notification, and records the
 * outcome to booking history tagged `source: 'manual'` so it shows in the dashboard.
 */
app.post('/api/book', requireAuth, async (req, res) => {
  const { restaurant, dates, partySize, time, autoPurchase, dryRun } = req.body as BookingRequest;

  if (!restaurant || !dates?.length || !partySize || !time) {
    res.status(400).json({ error: 'Missing required fields: restaurant, dates, partySize, time' });
    return;
  }

  console.log(`\n📨 Booking request: ${restaurant}`);
  const result = await runBooking({ restaurant, dates, partySize, time, autoPurchase, dryRun });
  await notifyResult(restaurant, result);

  addToHistory({
    id: crypto.randomUUID(),
    restaurant,
    date: result.bookedDate,
    time: result.bookedTime,
    success: result.success,
    error: result.error,
    screenshots: result.screenshots,
    ranAt: new Date().toISOString(),
    source: 'manual',
  });

  res.json(result);
});

/**
 * Legacy alias for /api/book kept for older clients/bookmarks. Same core call, but
 * intentionally does NOT write to history (history was added after this route).
 */
// Keep old /book endpoint for backward compat
app.post('/book', requireAuth, async (req, res) => {
  const { restaurant, dates, partySize, time, autoPurchase, dryRun } = req.body as BookingRequest;
  if (!restaurant || !dates?.length || !partySize || !time) {
    res.status(400).json({ error: 'Missing required fields' });
    return;
  }
  const result = await runBooking({ restaurant, dates, partySize, time, autoPurchase, dryRun });
  await notifyResult(restaurant, result);
  res.json(result);
});

// --- Scheduled bookings ---

/** List all scheduled bookings currently held in the scheduler's in-memory registry. */
app.get('/api/scheduled', requireAuth, (_req, res) => {
  res.json(getScheduledBookings());
});

/**
 * Register a new scheduled booking. Two timing modes are mutually supported:
 *   - `runAt` (ISO datetime): one-shot fired via setTimeout for precise, sub-second timing
 *     at a known drop moment — no cron needed.
 *   - `cron`: recurring schedule; required only when `runAt` is absent.
 * A request may also carry a `blitz` or `sniper` sub-config that is validated here and
 * stored on the booking, so the scheduler fires the right engine at drop time.
 */
app.post('/api/scheduled', requireAuth, (req, res) => {
  const { runAt, blitz, sniper, ...rest } = req.body;

  if (runAt && isNaN(new Date(runAt).getTime())) {
    return res.status(400).json({ success: false, error: 'Invalid runAt datetime' });
  }

  // cron is only needed for recurring schedules (no runAt).
  // When runAt is set, the scheduler uses setTimeout for precise timing.
  let cronExpr = rest.cron;
  if (!runAt && !cronExpr) {
    return res.status(400).json({ success: false, error: 'Either runAt or cron is required' });
  }

  // Normalize + validate sniper config NOW, not at fire time — a bad config (or a real
  // run without a price cap) must fail the schedule request, not the drop.
  let sniperCfg: SniperConfig | undefined;
  if (sniper) {
    // Clamp/default every field so a partial or hostile client payload can't produce an
    // out-of-range config. `pool` is capped at 6 (browser-pool ceiling); `fastPoll` and
    // `apiGrab` default ON (=== false opt-out). This mirrors the /api/sniper normalization
    // below — keep the two in sync.
    sniperCfg = {
      pool: Math.min(Math.max(sniper.pool ?? 5, 1), 6),
      pollIntervalMs: sniper.pollIntervalMs ?? 200,
      windowStartMs: sniper.windowStartMs ?? -1000,
      windowEndMs: sniper.windowEndMs ?? 10000,
      dryRun: !!sniper.dryRun,
      timeWindowStart24: sniper.timeWindowStart24 || undefined,
      timeWindowEnd24: sniper.timeWindowEnd24 || undefined,
      maxPriceCents: sniper.maxPriceCents,
      fastPoll: sniper.fastPoll !== false,
      apiGrab: sniper.apiGrab !== false,
    };
    const cfgError = validateSniperConfig(sniperCfg);
    if (cfgError) {
      return res.status(400).json({ success: false, error: `Invalid sniper config: ${cfgError}` });
    }
  }

  const booking: ScheduledBooking = {
    id: crypto.randomUUID(),
    createdAt: new Date().toISOString(),
    ...rest,
    cron: cronExpr || '',
    runAt,
    // Only treat as a blitz when it actually asks for >1 attempt; a single attempt is a
    // plain booking, so normalize that back to undefined.
    blitz: blitz && blitz.attempts > 1 ? blitz : undefined,
    sniper: sniperCfg,
  };
  const result = addScheduledBooking(booking);
  if (result.success) {
    res.json({ success: true, booking });
  } else {
    res.status(400).json(result);
  }
});

/** Cancel a scheduled booking by id; clears its pending timer/cron in the scheduler. */
app.delete('/api/scheduled/:id', requireAuth, (req, res) => {
  const removed = removeScheduledBooking(req.params.id);
  res.json({ success: removed });
});

// --- Manual blitz endpoint ---

/**
 * Fire a blitz (N parallel booking attempts, staggered) immediately, bypassing the
 * scheduler. `attempts` is capped at 5 to bound concurrent browser load; on completion
 * the result is written to history, emitted over SSE, and pushed to notifications.
 * Wrapped in try/catch because runBlitz drives real browsers and can throw.
 */
app.post('/api/blitz', requireAuth, async (req, res) => {
  const { blitz, ...bookingReq } = req.body;
  if (!bookingReq.restaurant || !bookingReq.dates?.length || !bookingReq.time || !bookingReq.partySize) {
    return res.status(400).json({ success: false, error: 'Missing required fields: restaurant, dates, time, partySize' });
  }
  if (!blitz || !blitz.attempts || blitz.attempts < 2) {
    return res.status(400).json({ success: false, error: 'blitz.attempts must be >= 2' });
  }
  const config: BlitzConfig = {
    attempts: Math.min(blitz.attempts, 5),
    staggerMs: blitz.staggerMs || 1000,
  };
  try {
    const result = await runBlitz(bookingReq, config);
    const entry = {
      id: crypto.randomUUID(),
      restaurant: bookingReq.restaurant,
      date: result.result.bookedDate,
      time: result.result.bookedTime,
      success: result.success,
      error: result.result.error,
      screenshots: result.result.screenshots,
      ranAt: new Date().toISOString(),
      source: 'manual' as const,
      blitzMeta: {
        winningAttempt: result.winningAttempt,
        totalAttempted: result.totalAttempted,
        totalAborted: result.totalAborted,
        durationMs: result.durationMs,
        attempts: result.attempts,
      },
    };
    addToHistory(entry);
    schedulerEvents.emit('booking-result', entry);
    await notifyResult(bookingReq.restaurant, result.result,
      { winningAttempt: result.winningAttempt, totalAttempted: result.totalAttempted });
    res.json(result);
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    console.error('❌ Blitz endpoint error:', error);
    res.status(500).json({ success: false, error: `Blitz failed: ${error}` });
  }
});

// --- SSE for live notifications ---

/**
 * Server-Sent Events stream that pushes each booking outcome to the dashboard in real
 * time. Subscribes to the scheduler's shared `booking-result` bus (emitted by manual
 * blitz/sniper handlers and by scheduled fires) and forwards a trimmed payload.
 * The `req.on('close')` handler unsubscribes to avoid leaking listeners per connection.
 */
app.get('/api/events', requireAuth, (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  // Only forward display fields — screenshots/large blobs are fetched on demand, not streamed.
  const onResult = (entry: BookingHistoryEntry) => {
    const data = JSON.stringify({
      success: entry.success,
      restaurant: entry.restaurant,
      date: entry.date,
      time: entry.time,
      error: entry.error,
      blitzMeta: entry.blitzMeta,
    });
    res.write(`data: ${data}\n\n`);
  };

  schedulerEvents.on('booking-result', onResult);
  req.on('close', () => schedulerEvents.off('booking-result', onResult));
});

// --- Booking history ---

/**
 * List past booking outcomes for the dashboard. Strips the (large, base64) screenshots
 * from each entry and replaces them with a `hasScreenshots` flag; the images themselves
 * are fetched individually via the screenshot route below to keep this response small.
 */
app.get('/api/history', requireAuth, (_req, res) => {
  // Return history without screenshots (too large for list view)
  const history = getHistory().map(({ screenshots, ...rest }) => ({
    ...rest,
    hasScreenshots: !!screenshots?.length,
  }));
  res.json(history);
});

/** Delete a single history entry by id. */
app.delete('/api/history/:id', requireAuth, (req, res) => {
  const removed = deleteHistoryEntry(req.params.id);
  res.json({ success: removed });
});

/** Wipe all booking history. */
app.delete('/api/history', requireAuth, (_req, res) => {
  clearHistory();
  res.json({ success: true });
});

/**
 * Serve one screenshot from a history entry as a raw PNG (decoded from its stored base64),
 * addressed by entry id + index. Returns 404 if the entry or that index is absent.
 */
app.get('/api/history/:id/screenshot/:index', requireAuth, (req, res) => {
  const entry = getHistory().find(h => h.id === req.params.id);
  const idx = parseInt(req.params.index);
  if (!entry?.screenshots?.[idx]) {
    res.status(404).json({ error: 'Screenshot not found' });
    return;
  }
  const buf = Buffer.from(entry.screenshots[idx], 'base64');
  res.setHeader('Content-Type', 'image/png');
  res.send(buf);
});

// --- Sniper (high-frequency drop capture) ---

/**
 * Fire the sniper engine immediately (manual, scheduler-bypassing run). Normalizes and
 * validates the sniper config identically to POST /api/scheduled — keep the two blocks in
 * sync — then runs `runSniper` optionally aligned to `sniper.runAt`. Records the outcome
 * to history/SSE/notifications; dry runs are labelled in the history `error` field so a
 * rehearsal (no card charged) can never be mistaken for a real booking.
 */
app.post('/api/sniper', requireAuth, async (req, res) => {
  const { sniper, ...bk } = req.body;
  if (!bk.restaurant || !bk.dates?.length || !bk.time || !bk.partySize) {
    return res.status(400).json({ success: false, error: 'Missing required fields: restaurant, dates, time, partySize' });
  }
  const cfg: SniperConfig = {
    pool: Math.min(Math.max(sniper?.pool ?? 5, 1), 6),
    pollIntervalMs: sniper?.pollIntervalMs ?? 200,
    windowStartMs: sniper?.windowStartMs ?? -1000,
    windowEndMs: sniper?.windowEndMs ?? 10000,
    dryRun: !!sniper?.dryRun,
    timeWindowStart24: sniper?.timeWindowStart24,
    timeWindowEnd24: sniper?.timeWindowEnd24,
    maxPriceCents: sniper?.maxPriceCents,
    fastPoll: sniper?.fastPoll !== false,
    apiGrab: sniper?.apiGrab !== false,
  };
  const cfgError = validateSniperConfig(cfg);
  if (cfgError) {
    return res.status(400).json({ success: false, error: cfgError });
  }
  try {
    const result = await runSniper(bk, cfg, sniper?.runAt);
    const entry = {
      id: crypto.randomUUID(),
      restaurant: bk.restaurant,
      date: result.bookedDate,
      time: result.bookedTime,
      success: result.success,
      // Make a rehearsal unmistakable in history (no charge happened).
      error: result.dryRun ? `[DRY RUN] ${result.error ?? 'reached checkout, no purchase'}` : result.error,
      screenshots: result.screenshots,
      ranAt: new Date().toISOString(),
      source: 'manual' as const,
      sniperMeta: { polls: result.polls, seen: result.seen, durationMs: result.durationMs },
    };
    addToHistory(entry);
    schedulerEvents.emit('booking-result', entry);
    await notifyResult(bk.restaurant, result);
    res.json(result);
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    console.error('❌ Sniper endpoint error:', error);
    res.status(500).json({ success: false, error: `Sniper failed: ${error}` });
  }
});

// --- Frozen recovery sessions ---
// When a booking run hits an unrecoverable snag (e.g. a challenge or unexpected page),
// the engine "freezes" its live browser instead of tearing it down, so an operator can
// inspect and hand-drive it to completion through these routes.

/** List currently frozen browser sessions available for manual recovery. */
app.get('/api/sessions', requireAuth, (_req, res) => res.json(listSessions()));

/** Live PNG screenshot of a frozen session's page (404 if the session is gone). */
app.get('/api/sessions/:id/screenshot', requireAuth, async (req, res) => {
  const b64 = await sessionScreenshot(req.params.id);
  if (!b64) { res.status(404).json({ error: 'Session or screenshot not found' }); return; }
  res.setHeader('Content-Type', 'image/png');
  res.send(Buffer.from(b64, 'base64'));
});

/**
 * Apply a manual action (click/type/etc.) to a frozen session's live browser, letting an
 * operator nudge a stuck run past a challenge. Action semantics live in sessions.applyAction.
 */
app.post('/api/sessions/:id/action', requireAuth, async (req, res) => {
  const { action, value } = req.body ?? {};
  res.json(await applyAction(req.params.id, action, value));
});

// --- Cookies ---
// The server books as a logged-in Tock user by replaying that user's session cookies.
// These routes keep that cookie jar fresh from several sources (dashboard, bookmarklet,
// auto-login), since a stale session is the most common cause of booking failure.

/** Report how many Tock session cookies are currently loaded (drives the UI status pill). */
app.get('/api/cookies/status', requireAuth, (_req, res) => {
  const cookies = getCookies();
  res.json({ count: cookies.length, loaded: cookies.length > 0 });
});

/** Replace the in-memory Tock cookie jar with a client-supplied array. */
app.post('/api/cookies', requireAuth, (req, res) => {
  const { cookies } = req.body;
  if (!Array.isArray(cookies)) {
    res.status(400).json({ error: 'Body must contain a "cookies" array' });
    return;
  }
  updateCookies(cookies);
  res.json({ success: true, count: cookies.length });
});

/**
 * CORS preflight for the bookmarklet push. A bookmarklet running on exploretock.com is a
 * cross-origin caller, so it needs an explicit OPTIONS 204 with permissive CORS headers
 * before the browser will send the POST.
 */
// Bookmarklet endpoint — accepts cookies from exploretock.com via CORS
// Auth via API_KEY in query string (since bookmarklet can't set cookies/headers easily)
app.options('/api/cookies/push', (_req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.status(204).end();
});

/**
 * Receive the user's live Tock cookies from a browser bookmarklet. Auth is via `?key=`
 * in the query string rather than requireAuth: a bookmarklet can't easily attach an
 * Authorization header or the dashboard cookie on a cross-origin request. This is the
 * quickest way to refresh the session after a Turnstile challenge invalidates auto-login.
 */
app.post('/api/cookies/push', (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');

  const key = req.query.key as string;
  if (API_KEY && key !== API_KEY) {
    res.status(401).json({ error: 'Invalid key' });
    return;
  }

  const { cookies } = req.body;
  if (!Array.isArray(cookies)) {
    res.status(400).json({ error: 'Body must contain a "cookies" array' });
    return;
  }

  updateCookies(cookies);
  console.log(`🍪 Bookmarklet pushed ${cookies.length} cookies`);
  res.json({ success: true, count: cookies.length });
});

/**
 * Auto-login: drive a real Playwright browser to log into Tock and harvest the resulting
 * session cookies. On success the credentials are persisted so startSessionRefresh can
 * silently re-login and keep the jar warm; note Turnstile challenges can still break this
 * path, which is why the manual bookmarklet push above exists as a fallback.
 */
// Auto-login: use Playwright to log into Tock and extract cookies
app.post('/api/tock-login', requireAuth, async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) {
    res.status(400).json({ error: 'email and password required' });
    return;
  }
  console.log(`\n🔐 Tock login request for ${email}`);
  const result = await loginToTock(email, password);
  if (result.success) {
    saveTockCredentials(email, password);
    console.log('💾 Tock credentials saved for auto-refresh');
  }
  res.json(result);
});

/** Report whether Tock credentials are saved for auto-refresh (email only — never the password). */
app.get('/api/tock-credentials', requireAuth, (_req, res) => {
  const creds = getTockCredentials();
  res.json({ saved: !!creds, email: creds?.email || null });
});

/** Legacy alias for POST /api/cookies kept for older clients. */
// Keep old /cookies endpoint
app.post('/cookies', requireAuth, (req, res) => {
  const { cookies } = req.body;
  if (!Array.isArray(cookies)) { res.status(400).json({ error: 'Bad request' }); return; }
  updateCookies(cookies);
  res.json({ success: true, count: cookies.length });
});

// --- Payment config ---

/**
 * Read the configured payment details for the dashboard. The full card number is never
 * returned — only the last 4 digits — so the secret can't be exfiltrated via this route.
 */
app.get('/api/payment', requireAuth, (_req, res) => {
  const payment = getPayment();
  if (!payment) {
    res.json({ configured: false });
    return;
  }
  // Mask card number for display
  res.json({
    configured: true,
    cardLast4: payment.cardNumber.slice(-4),
    cardExpiry: payment.cardExpiry,
    billingName: payment.billingName,
    billingAddress: payment.billingAddress,
    billingCity: payment.billingCity,
    billingState: payment.billingState,
    billingZip: payment.billingZip,
  });
});

/**
 * Set the runtime payment override (full card details, held in stripe.ts memory) that
 * takes priority over any env/file-configured card for subsequent bookings.
 */
app.post('/api/payment', requireAuth, (req, res) => {
  setPaymentOverride(req.body as PaymentDetails);
  res.json({ success: true });
});

// --- Redirect root to UI ---

/** Convenience redirect so hitting the bare host lands on the dashboard. */
app.get('/', (_req, res) => {
  res.redirect('/ui/');
});

// --- Start ---

const PORT = parseInt(process.env.PORT || '3000', 10);

// Boot order matters: hydrate the cookie jar from env, then start the scheduler (which may
// fire runAt/cron jobs) and the background session-refresh loop, all BEFORE we accept
// traffic — so an early request never races an unwarmed session or an unstarted scheduler.
loadCookiesFromEnv();
startScheduler();
startSessionRefresh();

app.listen(PORT, () => {
  const cookies = getCookies();
  console.log(`
╔═══════════════════════════════════════════╗
║     Tock Booking Server Running           ║
╠═══════════════════════════════════════════╣
║  Web UI:  /ui                             ║
║  API:     /api/book, /api/scheduled, ...  ║
║  Health:  /health                         ║
╠═══════════════════════════════════════════╣
║  Port: ${String(PORT).padEnd(35)}║
║  Cookies: ${String(cookies.length > 0 ? `${cookies.length} loaded` : 'Not set').padEnd(31)}║
║  Auth: ${String(API_KEY ? 'Enabled' : 'Disabled').padEnd(34)}║
╚═══════════════════════════════════════════╝
`);
});
