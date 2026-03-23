import express from 'express';
import path from 'path';
import crypto from 'crypto';
import { runBooking, BookingRequest } from './booker';
import { loadCookiesFromEnv, updateCookies, getCookies } from './cookies';
import { startScheduler, addScheduledBooking, removeScheduledBooking, getScheduledBookings, getHistory, addToHistory, ScheduledBooking } from './scheduler';
import { getPayment, setPaymentOverride, PaymentDetails } from './stripe';
import { notifyResult } from './notify';

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
  const booking: ScheduledBooking = {
    id: crypto.randomUUID(),
    createdAt: new Date().toISOString(),
    ...req.body,
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

// --- Booking history ---

app.get('/api/history', requireAuth, (_req, res) => {
  // Return history without screenshots (too large for list view)
  const history = getHistory().map(({ screenshots, ...rest }) => ({
    ...rest,
    hasScreenshots: !!screenshots?.length,
  }));
  res.json(history);
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
