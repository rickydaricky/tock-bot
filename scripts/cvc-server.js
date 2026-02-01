#!/usr/bin/env node
/**
 * Tock CVC Automation Server
 *
 * A lightweight local server that triggers the CVC AppleScript when called.
 * The Chrome extension calls this server to automate CVC entry.
 *
 * Usage:
 *   node cvc-server.js          # Start server
 *   node cvc-server.js --port 3847  # Custom port
 *
 * The server listens on http://localhost:3847/trigger-cvc
 */

const http = require('http');
const { execSync, exec } = require('child_process');
const fs = require('fs');
const path = require('path');

const PORT = process.argv.includes('--port')
  ? parseInt(process.argv[process.argv.indexOf('--port') + 1])
  : 3847;

const SCRIPT_DIR = __dirname;
const CONFIG_PATH = path.join(SCRIPT_DIR, 'tock-cvc-config.json');

// Read config
function readConfig() {
  try {
    const config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
    return {
      cvc: (config.cvc && config.cvc !== 'YOUR_CVC_HERE') ? config.cvc : null,
      browser: config.browser || 'Google Chrome',
      chromeOffset: config.chromeOffset
    };
  } catch (err) {
    console.error('Error reading config:', err.message);
    return { cvc: null, browser: 'Google Chrome', chromeOffset: undefined };
  }
}

// Legacy function for backward compatibility
function readCVC() {
  return readConfig().cvc;
}

// Run the CVC automation
// viewportCoords: { x, y } - coordinates relative to the browser's viewport (from getBoundingClientRect)
function runCVCAutomation(viewportCoords, callback) {
  const config = readConfig();
  if (!config.cvc) {
    callback(new Error('CVC not configured. Edit tock-cvc-config.json'));
    return;
  }

  const { cvc, browser } = config;
  // Browser chrome offset (tabs + address bar height) - adjust if needed
  const chromeOffset = config.chromeOffset || 85;
  console.log(`Using browser: ${browser}`);

  // If we received coordinates from the extension, use them
  // Otherwise fall back to percentage-based positioning
  const useProvidedCoords = viewportCoords && viewportCoords.x && viewportCoords.y;
  if (useProvidedCoords) {
    console.log(`Using provided viewport coordinates: (${viewportCoords.x}, ${viewportCoords.y})`);
  } else {
    console.log('No coordinates provided, using fallback percentage positioning');
  }

  // AppleScript to click CVC field, type code, and press Enter
  // Use the application directly to get window bounds (more reliable than System Events)
  const appleScript = `
    tell application "${browser}"
      activate
      delay 0.2

      -- Get window bounds: {left, top, right, bottom}
      set winBounds to bounds of window 1
      set winX to item 1 of winBounds
      set winY to item 2 of winBounds
      ${useProvidedCoords ? `
      -- Use coordinates provided by extension (viewport coords + window position + chrome offset)
      set clickX to winX + ${viewportCoords.x}
      set clickY to winY + ${chromeOffset} + ${viewportCoords.y}
      ` : `
      -- Fallback: use percentage-based positioning
      set winWidth to (item 3 of winBounds) - winX
      set winHeight to (item 4 of winBounds) - winY
      set clickX to round (winX + (winWidth * 0.55))
      set clickY to round (winY + (winHeight * 0.52))
      `}

      log "Window at: " & winX & ", " & winY
      log "Clicking at: " & clickX & ", " & clickY
    end tell

    -- Click using cliclick
    do shell script "/opt/homebrew/bin/cliclick c:" & clickX & "," & clickY
    delay 0.3

    -- Type CVC and press Enter
    tell application "System Events"
      keystroke "${cvc}"
      delay 0.1
      keystroke return
    end tell
  `;

  const escapedScript = appleScript.replace(/'/g, "'\"'\"'");
  console.log('Executing AppleScript...');

  exec(`osascript -e '${escapedScript}' 2>&1`, (error, stdout, stderr) => {
    if (stdout) console.log('AppleScript output:', stdout);
    if (stderr) console.log('AppleScript stderr:', stderr);
    if (error) {
      console.error('AppleScript error:', error.message);
      callback(error);
    } else {
      callback(null, 'CVC automation completed');
    }
  });
}

// Create HTTP server
const server = http.createServer((req, res) => {
  // CORS headers for Chrome extension
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  if (req.url === '/trigger-cvc' && (req.method === 'GET' || req.method === 'POST')) {
    console.log(`[${new Date().toISOString()}] CVC automation triggered`);

    // Parse request body for coordinates (if POST with JSON body)
    let body = '';
    req.on('data', chunk => {
      body += chunk.toString();
    });

    req.on('end', () => {
      let coords = null;
      if (body) {
        try {
          coords = JSON.parse(body);
        } catch (e) {
          // Ignore parse errors, just use fallback positioning
        }
      }

      runCVCAutomation(coords, (err, result) => {
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
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', cvcConfigured: !!readCVC() }));
    return;
  }

  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'Not found' }));
});

server.listen(PORT, '127.0.0.1', () => {
  const config = readConfig();
  console.log(`
╔═══════════════════════════════════════════════════════╗
║         Tock CVC Automation Server Running            ║
╠═══════════════════════════════════════════════════════╣
║  URL: http://localhost:${PORT}/trigger-cvc              ║
║  Browser: ${config.browser.padEnd(42)}║
║  CVC Configured: ${config.cvc ? 'Yes ✓' : 'No ✗ (edit tock-cvc-config.json)'}                       ║
╚═══════════════════════════════════════════════════════╝

The extension will automatically trigger this server
when the purchase confirmation page is ready.

Press Ctrl+C to stop.
`);
});

// Handle shutdown gracefully
process.on('SIGINT', () => {
  console.log('\nShutting down server...');
  server.close();
  process.exit(0);
});
