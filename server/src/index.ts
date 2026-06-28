import express from 'express';
import path from 'path';
import crypto from 'crypto';
import { runBooking, BookingRequest } from './booker';
import { runBlitz, BlitzConfig } from './blitz';
import { runSniper, SniperConfig } from './sniper';
import { listSessions, sessionScreenshot, applyAction } from './sessions';
import { loadCookiesFromEnv, updateCookies, getCookies } from './cookies';
import { startScheduler, addScheduledBooking, removeScheduledBooking, getScheduledBookings, getHistory, addToHistory, deleteHistoryEntry, clearHistory, ScheduledBooking, schedulerEvents, BookingHistoryEntry } from './scheduler';
import { getPayment, setPaymentOverride, PaymentDetails } from './stripe';
import { notifyResult } from './notify';
import { loginToTock } from './login';
import { saveTockCredentials, getTockCredentials, startSessionRefresh } from './session';

const app = express();
app.use(express.json({ limit: '5mb' }));

const API_KEY = process.env.API_KEY;

// Payment override is now managed in stripe.ts via setPaymentOverride/getPayment

// --- Auth middleware ---

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

app.use('/ui', express.static(path.join(__dirname, 'public')));

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

app.get('/api/scheduled', requireAuth, (_req, res) => {
  res.json(getScheduledBookings());
});

app.post('/api/scheduled', requireAuth, (req, res) => {
  const { runAt, blitz, ...rest } = req.body;

  if (runAt && isNaN(new Date(runAt).getTime())) {
    return res.status(400).json({ success: false, error: 'Invalid runAt datetime' });
  }

  // cron is only needed for recurring schedules (no runAt).
  // When runAt is set, the scheduler uses setTimeout for precise timing.
  let cronExpr = rest.cron;
  if (!runAt && !cronExpr) {
    return res.status(400).json({ success: false, error: 'Either runAt or cron is required' });
  }

  const booking: ScheduledBooking = {
    id: crypto.randomUUID(),
    createdAt: new Date().toISOString(),
    ...rest,
    cron: cronExpr || '',
    runAt,
    blitz: blitz && blitz.attempts > 1 ? blitz : undefined,
  };
  const result = addScheduledBooking(booking);
  if (result.success) {
    res.json({ success: true, booking });
  } else {
    res.status(400).json(result);
  }
});

app.delete('/api/scheduled/:id', requireAuth, (req, res) => {
  const removed = removeScheduledBooking(req.params.id);
  res.json({ success: removed });
});

// --- Manual blitz endpoint ---

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

app.get('/api/events', requireAuth, (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

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

app.get('/api/history', requireAuth, (_req, res) => {
  // Return history without screenshots (too large for list view)
  const history = getHistory().map(({ screenshots, ...rest }) => ({
    ...rest,
    hasScreenshots: !!screenshots?.length,
  }));
  res.json(history);
});

app.delete('/api/history/:id', requireAuth, (req, res) => {
  const removed = deleteHistoryEntry(req.params.id);
  res.json({ success: removed });
});

app.delete('/api/history', requireAuth, (_req, res) => {
  clearHistory();
  res.json({ success: true });
});

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
  };
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

app.get('/api/sessions', requireAuth, (_req, res) => res.json(listSessions()));

app.get('/api/sessions/:id/screenshot', requireAuth, async (req, res) => {
  const b64 = await sessionScreenshot(req.params.id);
  if (!b64) { res.status(404).json({ error: 'Session or screenshot not found' }); return; }
  res.setHeader('Content-Type', 'image/png');
  res.send(Buffer.from(b64, 'base64'));
});

app.post('/api/sessions/:id/action', requireAuth, async (req, res) => {
  const { action, value } = req.body ?? {};
  res.json(await applyAction(req.params.id, action, value));
});

// --- Cookies ---

app.get('/api/cookies/status', requireAuth, (_req, res) => {
  const cookies = getCookies();
  res.json({ count: cookies.length, loaded: cookies.length > 0 });
});

app.post('/api/cookies', requireAuth, (req, res) => {
  const { cookies } = req.body;
  if (!Array.isArray(cookies)) {
    res.status(400).json({ error: 'Body must contain a "cookies" array' });
    return;
  }
  updateCookies(cookies);
  res.json({ success: true, count: cookies.length });
});

// Bookmarklet endpoint — accepts cookies from exploretock.com via CORS
// Auth via API_KEY in query string (since bookmarklet can't set cookies/headers easily)
app.options('/api/cookies/push', (_req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.status(204).end();
});

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

app.get('/api/tock-credentials', requireAuth, (_req, res) => {
  const creds = getTockCredentials();
  res.json({ saved: !!creds, email: creds?.email || null });
});

// Keep old /cookies endpoint
app.post('/cookies', requireAuth, (req, res) => {
  const { cookies } = req.body;
  if (!Array.isArray(cookies)) { res.status(400).json({ error: 'Bad request' }); return; }
  updateCookies(cookies);
  res.json({ success: true, count: cookies.length });
});

// --- Payment config ---

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

app.post('/api/payment', requireAuth, (req, res) => {
  setPaymentOverride(req.body as PaymentDetails);
  res.json({ success: true });
});

// --- Redirect root to UI ---

app.get('/', (_req, res) => {
  res.redirect('/ui/');
});

// --- Start ---

const PORT = parseInt(process.env.PORT || '3000', 10);

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
