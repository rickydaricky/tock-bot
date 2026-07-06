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
 *
 * Role in the system:
 *   This is the OS-level "hands" of the auto-purchase flow. The Chrome
 *   extension content script (src/content/form-filler.ts) cannot reach into
 *   Stripe's cross-origin iframes to set field values, so it computes each
 *   iframe's on-screen geometry and POSTs it here; this server replays real
 *   mouse clicks (cliclick) and keystrokes (System Events) at those pixels to
 *   drive the payment form exactly as a human would. It is the only component
 *   that can defeat the cross-origin boundary, at the cost of being macOS-only
 *   and requiring the target browser window to be frontmost and unmoved.
 *
 * Key exports (module-internal — this file is run, not imported):
 *   - readConfig()               Load fallback card config from disk.
 *   - buildStripeFillerScript()  Emit AppleScript to fill the Stripe Payment
 *                                Element (+ optional Address Element).
 *   - buildBraintreeFillerScript() Emit AppleScript for the legacy Braintree
 *                                CVC-only field.
 *   - runCardAutomation()        Merge request + config, build, and exec the
 *                                AppleScript.
 *   - HTTP server                POST/GET /trigger-cvc and GET /health.
 *
 * Coordinate model (the load-bearing invariant of this file):
 *   All coordinates travel as CSS pixels relative to the browser's *viewport*
 *   top-left. To convert to absolute screen pixels for cliclick we add:
 *     screenX = window.x (AppleScript `bounds`) + viewportX
 *     screenY = window.y + chromeOffset + viewportY
 *   `chromeOffset` is the height of the browser's title bar + toolbar + tab
 *   strip (the "chrome") — the gap between the OS window's top edge and the
 *   web viewport's top edge. It is an empirical per-browser constant living in
 *   tock-cvc-config.json; if the toolbar layout changes, clicks land high/low.
 */

const http = require('http');
const { exec } = require('child_process');
const fs = require('fs');
const path = require('path');

// Default port 3847 is hard-coded into the extension's content script, so
// changing it here means the extension can no longer reach the server.
const PORT = process.argv.includes('--port')
  ? parseInt(process.argv[process.argv.indexOf('--port') + 1])
  : 3847;

const SCRIPT_DIR = __dirname;
// Fallback card config lives next to this script so the server is self-contained.
const CONFIG_PATH = path.join(SCRIPT_DIR, 'tock-cvc-config.json');

/**
 * Load the on-disk fallback card config (used when the extension does not send
 * card details in the request body).
 *
 * Notes:
 *   - `cvc` is treated as unset if it still holds the 'YOUR_CVC_HERE'
 *     placeholder shipped in the template, so a half-configured file reads as
 *     "no CVC" rather than typing the literal placeholder into Stripe.
 *   - `browser` is the AppleScript application name to `activate`/target
 *     (e.g. "Google Chrome", "Chromium"); `chromeOffset` is the browser-chrome
 *     pixel height described in the file header. Both default sanely so the
 *     server still boots with a missing/corrupt config.
 * @returns {{cardNumber: string|null, cardExpiry: string|null, cvc: string|null, browser: string, chromeOffset: number}}
 */
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
 * These percentages are empirical for Tock's Stripe layout; they only need to
 * land somewhere inside each field, not at its exact center.
 *
 * @param {object} config Merged card/billing details (see runCardAutomation).
 * @param {object} coords Viewport geometry from the content script. Requires
 *   x (iframe horizontal center), y (iframe top + 30), and iframeWidth for the
 *   payment iframe; optionally billingIframeX/Y/Width for the Address Element.
 * @returns {{script: string}|{error: string}} AppleScript source, or an error
 *   describing what's missing (card details or coords) — callers must branch.
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

  // Billing (Stripe Address Element) lives in a SECOND iframe and is optional:
  // only fill it when both a name and that iframe's coords are present. When
  // absent, the card-only script above still completes successfully.
  const hasBilling = config.billingName && coords.billingIframeY;
  if (hasBilling) {
    // Click into the "Full name" field at the top of the billing iframe
    // Then Tab through: Country (skip) → Address 1 → Address 2 (skip) → City → State → ZIP
    const billingClickX = Math.round((coords.billingIframeX || 0) + (coords.billingIframeWidth || 400) * 0.5);
    const billingClickY = Math.round(coords.billingIframeY + 30); // "Full name" near top

    console.log(`  Billing name click: (${billingClickX}, ${billingClickY})`);

    // These values get interpolated into double-quoted AppleScript string
    // literals below, so strip any " or \ that would break out of the literal
    // (and, worse, allow arbitrary AppleScript injection). Stripping rather
    // than escaping is safe here: real addresses don't contain these chars.
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
 * Build AppleScript for the legacy Braintree flow, which only needs the CVC
 * re-typed (card number/expiry come from a saved card). Kept for Tock pages
 * that haven't migrated to the Stripe Payment Element.
 *
 * Coordinate handling differs from Stripe: if the content script supplied
 * exact iframe coords we use them, otherwise we fall back to a blind guess at
 * 55% width / 52% height of the browser window — the empirical location of the
 * CVC box on Tock's legacy checkout. The fallback lets it work even when the
 * extension can't measure the iframe.
 *
 * @param {object} config Must contain cvc, browser, chromeOffset.
 * @param {object} [coords] Optional { x, y } viewport coords of the CVC field.
 * @returns {{script: string}|{error: string}} AppleScript source, or an error
 *   if no CVC is configured.
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

/**
 * Orchestrate one card-fill: merge inputs, pick the provider builder, and exec
 * the resulting AppleScript.
 *
 * The request body doubles as both the card-detail source AND the coordinate
 * payload — `requestData` is passed straight through as `coords` to the builder.
 * `requestData.isStripe` selects the Stripe vs Braintree builder.
 *
 * @param {object|null} requestData Parsed POST body: card/billing fields,
 *   iframe coords, and the isStripe flag. Null falls back entirely to config.
 * @param {(err: Error|null, result?: string) => void} callback Node-style cb.
 */
function runCardAutomation(requestData, callback) {
  const fileConfig = readConfig();
  const isStripe = requestData && requestData.isStripe;

  // Merge: request body (from extension) takes priority over config file.
  // Billing fields come ONLY from the request (never the on-disk fallback),
  // since the config file is card-only.
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

  // The script is passed to `osascript -e '<script>'` inside single quotes, so
  // any single quote in the script must be escaped using the classic shell
  // idiom '"'"' (close-quote, quoted-quote, reopen-quote). 2>&1 folds
  // AppleScript's stderr (its `log` output) into stdout for logging below.
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

// HTTP server. Two routes:
//   /trigger-cvc (GET|POST) — run the card automation; POST body carries card
//     details + iframe coords, GET is a bare trigger that relies on config only.
//   /health (GET)           — readiness probe reporting whether a card/CVC is
//     configured, used by the extension to decide if the server is usable.
// Bound to 127.0.0.1 only (see listen below); CORS is wide-open because the
// only caller is the extension content script running on tock.com, and the
// listener is unreachable off-box regardless of Origin.
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
      // Tolerate a missing/invalid body: a bare GET trigger has no JSON, and we
      // still want to attempt a config-only fill rather than 400 the caller.
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

// Listen on loopback only — this server drives real clicks/keystrokes on the
// local machine, so it must never be reachable from the network.
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

// Clean Ctrl+C shutdown so the loopback port is released for the next run.
process.on('SIGINT', () => {
  console.log('\nShutting down server...');
  server.close();
  process.exit(0);
});
