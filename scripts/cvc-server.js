#!/usr/bin/env node
/**
 * Tock Card Automation Server
 *
 * A local server that uses AppleScript + cliclick to fill Stripe Payment Element
 * and Address Element fields, since they're in cross-origin iframes that cannot
 * be accessed by Chrome extension content scripts.
 *
 * Fills: card number, expiry, CVC, billing name, address, city, state, ZIP.
 *
 * Card details come from the Chrome extension (popup UI → Chrome storage → HTTP
 * request body), with fallback to tock-cvc-config.json.
 *
 * Prerequisites:
 *   - cliclick: brew install cliclick
 *   - Accessibility permissions for osascript/terminal
 *
 * Usage:
 *   node cvc-server.js              # Start server on port 3847
 *   node cvc-server.js --port 3847  # Custom port
 */

const http = require('http');
const { exec } = require('child_process');
const fs = require('fs');
const path = require('path');

const PORT = process.argv.includes('--port')
  ? parseInt(process.argv[process.argv.indexOf('--port') + 1])
  : 3847;

const SCRIPT_DIR = __dirname;
const CONFIG_PATH = path.join(SCRIPT_DIR, 'tock-cvc-config.json');

function readConfig() {
  try {
    const config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
    return {
      cardNumber: config.cardNumber || null,
      cardExpiry: config.cardExpiry || null,
      cvc: (config.cvc && config.cvc !== 'YOUR_CVC_HERE') ? config.cvc : null,
      browser: config.browser || 'Google Chrome',
      chromeOffset: config.chromeOffset || 85
    };
  } catch (err) {
    console.error('Error reading config:', err.message);
    return { cardNumber: null, cardExpiry: null, cvc: null, browser: 'Google Chrome', chromeOffset: 85 };
  }
}

/**
 * Build AppleScript to fill Stripe Payment Element fields.
 *
 * Stripe Payment Element layout (single row inside iframe):
 *   [  Card number (wide)  ] [ Expiry MM/YY ] [ CVC ]
 *
 * Tab key doesn't reliably stay inside the Stripe iframe via AppleScript,
 * so we click directly into each field at calculated screen coordinates.
 *
 * Field positions (approximate percentages of iframe width):
 *   Card number: 0% - 52%   → click at 25%
 *   Expiry:      52% - 78%  → click at 65%
 *   CVC:         78% - 100% → click at 89%
 */
function buildStripeFillerScript(config, coords) {
  const { cardNumber, cardExpiry, cvc, browser, chromeOffset } = config;

  const missing = [];
  if (!cardNumber) missing.push('cardNumber');
  if (!cardExpiry) missing.push('cardExpiry');
  if (!cvc) missing.push('cvc');
  if (missing.length > 0) {
    return { error: `Missing card details in config: ${missing.join(', ')}` };
  }

  // Clean the expiry — Stripe expects MMYY typed sequentially (it auto-inserts the slash)
  const expiryDigits = cardExpiry.replace(/\D/g, '');

  const hasCoords = coords && coords.x && coords.y && coords.iframeWidth;

  if (!hasCoords) {
    return { error: 'No iframe coordinates provided — cannot calculate field positions' };
  }

  // Calculate the left edge and top of the iframe in viewport coords
  // coords.x was center of iframe, coords.y was top+30
  const iframeLeft = coords.x - (coords.iframeWidth / 2);
  const iframeTop = coords.y - 30; // undo the +30 offset from content script
  const fieldY = iframeTop + 30; // vertical center of the field row

  // Calculate click X for each field based on iframe width percentages
  const cardFieldX = Math.round(iframeLeft + coords.iframeWidth * 0.25);
  const expiryFieldX = Math.round(iframeLeft + coords.iframeWidth * 0.65);
  const cvcFieldX = Math.round(iframeLeft + coords.iframeWidth * 0.89);
  const fieldYRound = Math.round(fieldY);

  console.log(`  Iframe: left=${Math.round(iframeLeft)}, top=${Math.round(iframeTop)}, width=${coords.iframeWidth}`);
  console.log(`  Card click:   (${cardFieldX}, ${fieldYRound})`);
  console.log(`  Expiry click:  (${expiryFieldX}, ${fieldYRound})`);
  console.log(`  CVC click:     (${cvcFieldX}, ${fieldYRound})`);

  let script = `
    tell application "${browser}"
      activate
      delay 0.3

      set winBounds to bounds of window 1
      set winX to item 1 of winBounds
      set winY to item 2 of winBounds

      -- Calculate screen coordinates for each field
      set cardX to winX + ${cardFieldX}
      set expiryX to winX + ${expiryFieldX}
      set cvcX to winX + ${cvcFieldX}
      set fieldY to winY + ${chromeOffset} + ${fieldYRound}

      log "Card field at: " & cardX & ", " & fieldY
      log "Expiry field at: " & expiryX & ", " & fieldY
      log "CVC field at: " & cvcX & ", " & fieldY
    end tell

    -- 1) Click and type card number (click twice to ensure focus, longer delay for Stripe init)
    do shell script "/opt/homebrew/bin/cliclick c:" & cardX & "," & fieldY
    delay 0.5
    do shell script "/opt/homebrew/bin/cliclick c:" & cardX & "," & fieldY
    delay 0.5
    tell application "System Events"
      keystroke "${cardNumber}"
    end tell
    delay 0.8

    -- 2) Click and type expiry
    do shell script "/opt/homebrew/bin/cliclick c:" & expiryX & "," & fieldY
    delay 0.3
    tell application "System Events"
      keystroke "${expiryDigits}"
    end tell
    delay 0.3

    -- 3) Click and type CVC
    do shell script "/opt/homebrew/bin/cliclick c:" & cvcX & "," & fieldY
    delay 0.3
    tell application "System Events"
      keystroke "${cvc}"
    end tell
    delay 0.3
  `;

  // Append billing address filling if we have billing data and coords
  const hasBilling = config.billingName && coords.billingIframeY;
  if (hasBilling) {
    // Click into the "Full name" field at the top of the billing iframe
    // Then Tab through: Country (skip) → Address 1 → Address 2 (skip) → City → State → ZIP
    const billingClickX = Math.round((coords.billingIframeX || 0) + (coords.billingIframeWidth || 400) * 0.5);
    const billingClickY = Math.round(coords.billingIframeY + 30); // "Full name" near top

    console.log(`  Billing name click: (${billingClickX}, ${billingClickY})`);

    // Escape special AppleScript characters in address strings
    const escapedName = (config.billingName || '').replace(/["\\]/g, '');
    const escapedAddress = (config.billingAddress || '').replace(/["\\]/g, '');
    const escapedCity = (config.billingCity || '').replace(/["\\]/g, '');
    const escapedState = (config.billingState || '').replace(/["\\]/g, '');
    const escapedZip = (config.billingZip || '').replace(/["\\]/g, '');

    script += `
    -- 4) Fill billing address (separate Stripe iframe)
    -- Click "Full name" field
    set billingNameX to winX + ${billingClickX}
    set billingNameY to winY + ${chromeOffset} + ${billingClickY}
    do shell script "/opt/homebrew/bin/cliclick c:" & billingNameX & "," & billingNameY
    delay 0.3
    tell application "System Events"
      keystroke "${escapedName}"
      delay 0.3

      -- Tab into Country dropdown, then Tab past it (already "United States")
      keystroke tab
      delay 0.3
      keystroke tab
      delay 0.3

      -- Address line 1
      keystroke "${escapedAddress}"
      delay 0.5

      -- Dismiss address autocomplete dropdown
      key code 53
      delay 0.3

      -- Tab to Address line 2 (optional, skip it)
      keystroke tab
      delay 0.3

      -- Tab to City
      keystroke tab
      delay 0.3

      -- City
      keystroke "${escapedCity}"
      delay 0.3

      -- Tab to State dropdown
      keystroke tab
      delay 0.3

      -- State — type abbreviation to filter, then Enter to select
      keystroke "${escapedState}"
      delay 0.4
      keystroke return
      delay 0.4

      -- Tab to ZIP code
      keystroke tab
      delay 0.3

      -- ZIP code
      keystroke "${escapedZip}"
      delay 0.1
    end tell
    `;
  }

  return { script };
}

/**
 * Build AppleScript for legacy Braintree CVC-only fill.
 */
function buildBraintreeFillerScript(config, coords) {
  const { cvc, browser, chromeOffset } = config;

  if (!cvc) {
    return { error: 'CVC not configured in tock-cvc-config.json' };
  }

  const useCoords = coords && coords.x && coords.y;

  const script = `
    tell application "${browser}"
      activate
      delay 0.2

      set winBounds to bounds of window 1
      set winX to item 1 of winBounds
      set winY to item 2 of winBounds
      ${useCoords ? `
      set clickX to winX + ${coords.x}
      set clickY to winY + ${chromeOffset} + ${coords.y}
      ` : `
      set winWidth to (item 3 of winBounds) - winX
      set winHeight to (item 4 of winBounds) - winY
      set clickX to round (winX + (winWidth * 0.55))
      set clickY to round (winY + (winHeight * 0.52))
      `}
      log "Clicking CVC field at: " & clickX & ", " & clickY
    end tell

    do shell script "/opt/homebrew/bin/cliclick c:" & clickX & "," & clickY
    delay 0.3

    tell application "System Events"
      keystroke "${cvc}"
      delay 0.1
    end tell
  `;

  return { script };
}

function runCardAutomation(requestData, callback) {
  const fileConfig = readConfig();
  const isStripe = requestData && requestData.isStripe;

  // Merge: request body (from extension) takes priority over config file
  const config = {
    cardNumber: (requestData && requestData.cardNumber) || fileConfig.cardNumber,
    cardExpiry: (requestData && requestData.cardExpiry) || fileConfig.cardExpiry,
    cvc: (requestData && requestData.cvc) || fileConfig.cvc,
    billingName: requestData && requestData.billingName,
    billingAddress: requestData && requestData.billingAddress,
    billingCity: requestData && requestData.billingCity,
    billingState: requestData && requestData.billingState,
    billingZip: requestData && requestData.billingZip,
    browser: fileConfig.browser,
    chromeOffset: fileConfig.chromeOffset
  };

  console.log(`Payment provider: ${isStripe ? 'Stripe' : 'Braintree'}`);
  console.log(`Browser: ${config.browser}`);
  console.log(`Card source: ${(requestData && requestData.cardNumber) ? 'extension UI' : 'config file'}`);

  const result = isStripe
    ? buildStripeFillerScript(config, requestData)
    : buildBraintreeFillerScript(config, requestData);

  if (result.error) {
    callback(new Error(result.error));
    return;
  }

  const escapedScript = result.script.replace(/'/g, "'\"'\"'");
  console.log('Executing AppleScript...');

  exec(`osascript -e '${escapedScript}' 2>&1`, (error, stdout, stderr) => {
    if (stdout) console.log('AppleScript output:', stdout);
    if (stderr) console.log('AppleScript stderr:', stderr);
    if (error) {
      console.error('AppleScript error:', error.message);
      callback(error);
    } else {
      callback(null, `Card automation completed (${isStripe ? 'Stripe' : 'Braintree'})`);
    }
  });
}

// Create HTTP server
const server = http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  if (req.url === '/trigger-cvc' && (req.method === 'GET' || req.method === 'POST')) {
    console.log(`\n[${new Date().toISOString()}] Card automation triggered`);

    let body = '';
    req.on('data', chunk => { body += chunk.toString(); });

    req.on('end', () => {
      let requestData = null;
      if (body) {
        try { requestData = JSON.parse(body); } catch (e) { /* ignore */ }
      }

      runCardAutomation(requestData, (err, result) => {
        if (err) {
          console.error('Error:', err.message);
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: false, error: err.message }));
        } else {
          console.log('Success:', result);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: true, message: result }));
        }
      });
    });
    return;
  }

  if (req.url === '/health') {
    const config = readConfig();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      status: 'ok',
      cardConfigured: !!(config.cardNumber && config.cardExpiry && config.cvc),
      cvcConfigured: !!config.cvc
    }));
    return;
  }

  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'Not found' }));
});

server.listen(PORT, '127.0.0.1', () => {
  const config = readConfig();
  const cardOk = !!(config.cardNumber && config.cardExpiry && config.cvc);
  console.log(`
╔═══════════════════════════════════════════════════════╗
║       Tock Card Automation Server Running             ║
╠═══════════════════════════════════════════════════════╣
║  URL: http://localhost:${PORT}/trigger-cvc              ║
║  Browser: ${config.browser.padEnd(42)}║
║  Card configured: ${cardOk ? 'Yes ✓ (number + expiry + CVC)' : 'No ✗ (edit tock-cvc-config.json)'}     ║
╚═══════════════════════════════════════════════════════╝

Supports: Stripe Payment Element + Braintree (legacy)
The extension auto-triggers this on the purchase page.

Press Ctrl+C to stop.
`);
});

process.on('SIGINT', () => {
  console.log('\nShutting down server...');
  server.close();
  process.exit(0);
});
