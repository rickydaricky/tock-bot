import express from 'express';
import { runBooking, BookingRequest } from './booker';
import { loadCookiesFromEnv, updateCookies, getCookies } from './cookies';
import { startScheduler } from './scheduler';
import { notifyResult } from './notify';

const app = express();
app.use(express.json({ limit: '5mb' }));

const API_KEY = process.env.API_KEY;

function requireAuth(req: express.Request, res: express.Response, next: express.NextFunction): void {
  if (!API_KEY) { next(); return; }

  const auth = req.headers.authorization;
  if (auth !== `Bearer ${API_KEY}`) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }
  next();
}

// Health check
app.get('/health', (_req, res) => {
  const cookies = getCookies();
  res.json({
    status: 'ok',
    cookiesLoaded: cookies.length > 0,
    cookieCount: cookies.length,
  });
});

// Trigger a booking
app.post('/book', requireAuth, async (req, res) => {
  const { restaurant, dates, partySize, time, autoPurchase, dryRun } = req.body as BookingRequest;

  if (!restaurant || !dates?.length || !partySize || !time) {
    res.status(400).json({ error: 'Missing required fields: restaurant, dates, partySize, time' });
    return;
  }

  console.log(`\n📨 Booking request: ${restaurant}`);
  const result = await runBooking({ restaurant, dates, partySize, time, autoPurchase, dryRun });
  await notifyResult(restaurant, result);

  res.json(result);
});

// Update cookies without redeploying
app.post('/cookies', requireAuth, (req, res) => {
  const { cookies } = req.body;
  if (!Array.isArray(cookies)) {
    res.status(400).json({ error: 'Body must contain a "cookies" array' });
    return;
  }

  updateCookies(cookies);
  res.json({ success: true, count: cookies.length });
});

// Start
const PORT = parseInt(process.env.PORT || '3000', 10);

loadCookiesFromEnv();
startScheduler();

app.listen(PORT, () => {
  const cookies = getCookies();
  console.log(`
╔═══════════════════════════════════════════╗
║     Tock Booking Server Running           ║
╠═══════════════════════════════════════════╣
║  POST /book     — trigger a booking       ║
║  POST /cookies  — update session cookies  ║
║  GET  /health   — health check            ║
╠═══════════════════════════════════════════╣
║  Port: ${String(PORT).padEnd(35)}║
║  Cookies: ${cookies.length > 0 ? `${cookies.length} loaded ✓` : 'Not configured ✗'.padEnd(31)}║
║  Auth: ${API_KEY ? 'Enabled ✓' : 'Disabled ⚠'.padEnd(34)}║
╚═══════════════════════════════════════════╝
`);
});
