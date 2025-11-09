# Tock & OpenTable Reservation Form Filler

A Chrome extension that automatically fills in and submits reservation forms on both Tock and OpenTable restaurant reservation websites.

## Features

- **Multi-Platform Support**: Works with both Tock and OpenTable reservation systems
- **Smart Form Filling**: Automatically fills in party size, date, and time
- **Intelligent Time Matching**: Selects the time slot that matches (or is closest to) your preferred time
- **One-Click Submission**: Fills and submits the form with a single click
- **Scheduled Automation**: Set a drop time to automatically search and book reservations at a specific time
- **Optimized for Tock**: Direct URL navigation approach for ultra-fast execution (~1-2 seconds faster than form filling)
- **Fresh Data Guarantee**: Page refresh ensures you're always working with the latest availability from the server
- **Persistent Preferences**: Saves your settings for future use
- **Dynamic UI**: Extension popup title adapts based on whether you're on Tock or OpenTable

## Installation (Development Mode)

1. Clone this repository:
   ```bash
   git clone <repository-url>
   cd tock-bot
   ```

2. Install dependencies:
   ```bash
   npm install
   ```

3. Build the extension:
   ```bash
   npm run build
   ```

4. Load the extension in Chrome:
   - Open Chrome and navigate to `chrome://extensions/`
   - Enable "Developer mode" by toggling the switch in the top right corner
   - Click "Load unpacked" and select the `dist` directory from this project

## How to Use

### Manual Mode (Instant Fill)

1. Navigate to any Tock or OpenTable restaurant reservation page
2. Click the extension icon in your browser toolbar (the popup title will show "Tock" or "OpenTable" based on the current page)
3. Enter your desired party size, date, and time
4. Click "Fill Reservation Form Now"
5. The extension will automatically:
   - Fill in the party size, date, and time
   - Find and click the time slot that matches your preferred time (or the closest available)
   - Navigate to the booking page

### Automatic Mode (Scheduled)

1. Navigate to the restaurant reservation page you want to book
2. Open the extension popup
3. Check "Enable Automatic Search"
4. Set your preferences:
   - **Reservation Drop Time**: The exact time when reservations open (in your local timezone)
   - **Search Before Drop**: How many milliseconds before the drop time to start searching (default: 0ms - refreshes exactly at drop time)
   - **Maximum Retry Attempts**: How many times to retry if the first attempt fails (default: 0 - optimized for single-shot speed)
   - **Retry Interval**: How long to wait between retry attempts (in seconds)
5. Click "Schedule Timer"
6. The extension will automatically prepare and execute the booking at the specified time
7. You can monitor the countdown and cancel the timer if needed

**Tock-Specific Behavior**: When scheduling a timer on Tock, the extension immediately navigates to the search results page with your preferences in the URL. When the drop time arrives, it refreshes the page to load fresh availability data and clicks the "Book" button. This is significantly faster (~1-2 seconds) than form filling.

### Supported Platforms

- **Tock**: exploretock.com
- **OpenTable**: opentable.com and all international domains (UK, CA, JP, DE, ES, FR, IT, NL, AU, MX, IE, SG, HK, AE, TH, TW)

## Development

- `npm run dev` - Builds the extension in development mode with watch mode enabled
- `npm run build` - Builds the extension for production

## Project Structure

- `public/` - Static assets and manifest.json
- `src/` - Source code
  - `popup/` - React components for the popup UI
  - `content/` - Content scripts that interact with Tock and OpenTable websites
    - `form-filler.ts` - Tock form filling implementation
    - `opentable-form-filler.ts` - OpenTable form filling implementation
    - `index.ts` - Platform detection and routing
  - `background/` - Background service worker for scheduled automation
  - `utils/` - Utility functions including:
    - `platform.ts` - Platform detection
    - `storage.ts` - Chrome storage helpers
    - `messaging.ts` - Message passing utilities
    - `url-builder.ts` - Tock search URL construction and detection
  - `types/` - TypeScript type definitions

## Technologies Used

- TypeScript
- React 18
- Tailwind CSS
- Chrome Extensions API (Manifest V3)
- Webpack

## How It Works

### Platform Detection
The extension automatically detects whether you're on a Tock or OpenTable page by analyzing the URL and routes to the appropriate form filler implementation.

### Tock Implementation

**Manual Mode:**
- Uses direct DOM manipulation to fill form fields
- Interacts with custom Tock UI components
- Auto-clicks the search and book buttons

**Automatic Mode (Optimized for Speed):**
- Immediately navigates to the search URL when timer is scheduled
  - Example: `https://www.exploretock.com/restaurant-name/search?date=2025-11-07&size=2&time=20%3A00`
- Tab waits at the search page until drop time
- At drop time, refreshes the page to fetch fresh availability data from the server
- Skips all form filling and goes straight to clicking the "Book" button
- This approach is ~1-2 seconds faster because:
  - No form element waiting
  - No form filling steps
  - No search button navigation delay
  - Direct refresh loads latest availability from Tock's servers

**Why the refresh is necessary:** Tock uses client-side routing (SPA), so the search button doesn't make a fresh server request. Without a page refresh, the script would work with stale cached data loaded before the reservation drop.

### OpenTable Implementation
- Finds hidden `<select>` elements for party size, date, and time
- Converts between 24-hour and 12-hour time formats
- Navigates the react-day-picker calendar component
- Intelligently matches time slot buttons by parsing their text content
- Selects the exact or closest available time slot to your preference

### Scheduled Automation
- Uses Chrome Alarms API for precise timing
- Supports retry logic with configurable intervals
- Tracks timer status and displays countdown in real-time

## Known Limitations

- OpenTable dropdown changes (party size, date, time) don't visually update the displayed time slots, but clicking still works correctly
- Icons have been removed from this extension. If you want to add them back, you would need to:
  1. Create icon files (16x16, 48x48, 128x128 PNG files)
  2. Place them in a `public/images` directory
  3. Update the manifest.json to reference these icons
  4. Update the webpack.config.js to copy the images folder

## License

MIT 