# Claude Code Project Notes

## Development Workflow

### After Code Changes
**IMPORTANT**: Always run `npm run build` after making code changes to ensure the extension is properly built and ready to load in the browser.

```bash
npm run build
```

This builds the TypeScript source files and bundles the extension for Chrome.

## Auto-Purchase Architecture

The auto-purchase flow fills payment details on Tock's checkout page. Tock uses **Stripe Payment Element** (card number, expiry, CVC in a single cross-origin iframe) and **Stripe Address Element** (billing name, address, city, state, ZIP in a second cross-origin iframe).

Because these are cross-origin iframes, the Chrome extension content script cannot inject values directly. Instead:

1. **Content script** (`form-filler.ts` → `handlePurchaseConfirmation()`) detects the Stripe iframes, gets their viewport coordinates, and sends card/billing details + coordinates to a local HTTP server.
2. **Card automation server** (`scripts/cvc-server.js` at `localhost:3847`) uses AppleScript + `cliclick` to click into each field at calculated screen coordinates and type the values via `System Events keystroke`.

### Card details source priority
The server accepts card details in the HTTP request body (from Chrome extension storage / popup UI). Falls back to `scripts/tock-cvc-config.json` if not provided in the request.

### Stripe field interaction
- **Payment iframe**: Card number, expiry, CVC are on a single row. Each field is clicked directly by coordinate (Tab doesn't reliably stay inside the iframe). Card number needs a double-click with delay for Stripe init.
- **Billing iframe**: Fields are stacked vertically. After clicking "Full name", Tab navigation works between fields. Escape is sent after typing address to dismiss Google Places autocomplete dropdown. State dropdown requires typing the abbreviation + Enter.

### Key files
- `src/content/form-filler.ts` — `handlePurchaseConfirmation()`, `checkPurchaseCheckboxes()`
- `scripts/cvc-server.js` — `buildStripeFillerScript()`, `buildBraintreeFillerScript()`
- `scripts/tock-cvc-config.json` — Fallback card config + browser name + chromeOffset
