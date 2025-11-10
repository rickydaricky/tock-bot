# Tock & OpenTable Reservation Form Filler

A Chrome extension that automatically fills in and submits reservation forms on both Tock and OpenTable restaurant reservation websites.

## Features

- **Multi-Platform Support**: Works with both Tock and OpenTable reservation systems
- **Smart Form Filling**: Automatically fills in party size, date, and time
- **Visual Calendar Selection**: Interactive calendar with drag-to-select for choosing multiple specific dates
- **Bidirectional Auto-Scan**: Automatically try dates before AND after your primary date (±N days)
- **Flexible Date Strategies**:
  - Use primary date only
  - Select specific dates via calendar (overrides auto-scan)
  - Auto-scan ±N days from primary (if no calendar dates selected)
- **Intelligent Availability Filtering**: Only tries dates that Tock shows as available (skips disabled/sold out dates)
- **Intelligent Time Matching**: Selects the time slot that matches (or is closest to) your preferred time
- **One-Click Submission**: Fills and submits the form with a single click
- **Scheduled Automation**: Set a drop time to automatically search and book reservations at a specific time
- **Advanced Timing Control**:
  - **Flexible Search Offset**: Search before OR after drop time (e.g., -1500ms = 1.5 seconds AFTER 9pm)
  - **Auto-Refresh on Empty Slots**: Automatically retry if no slots detected (immediate retries, no delay)
  - **Aggressive Slot Detection**: Checks every 100ms for first 5 seconds to catch slots the instant they appear
- **Optimized for Tock**: Direct calendar interaction for ultra-fast date switching
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
   - **Party Size & Primary Date**: Your preferred party size and first-choice date
   - **Use First Available Date** (Optional): Check this to enable flexible date searching
     - **Days to Scan**: Set how many days before/after your primary date to scan (e.g., 7 means ±7 days)
     - **Calendar Selection**: Click "Or select specific dates" to open an interactive calendar
       - **Single Click**: Click individual dates to select them
       - **Drag Selection**: Click and drag across dates to select entire ranges sequentially
       - Drag from unselected → selects the range
       - Drag from selected → deselects the range
       - **Calendar dates override auto-scan**: If you select specific dates, the scan range is ignored
   - **Reservation Drop Time**: The exact time when reservations open (in your local timezone)
   - **Search Offset (ms)**: When to refresh relative to drop time
     - **Positive values** (e.g., 200): Refresh BEFORE drop time (200ms early)
     - **Negative values** (e.g., -1500): Refresh AFTER drop time (1.5 seconds late)
     - **Recommended for Tock**: -1500 to -2000 (gives server time to process the 9pm update)
   - **Auto-refresh if no slots found** (Optional): Automatically retry if no slots detected
     - **Max Refresh Attempts**: How many times to refresh and check (1-10)
     - Retries happen immediately with no delay for maximum speed
5. Click "Schedule Timer"
6. The extension will automatically prepare and execute the booking at the specified time
7. You can monitor the countdown and cancel the timer if needed

**Tock-Specific Behavior with Date Selection**:
- The extension navigates to the search page with your primary date
- At drop time, it refreshes the page to fetch fresh availability
- It parses the calendar to find which dates actually have availability (marked with `is-available` class)
- Date selection logic:
  - If **calendar dates selected**: Only tries those specific dates
  - If **no calendar dates**: Tries all dates within ±N days of primary
  - Always filters to only try dates that Tock shows as available
- For each available date, it:
  - Clicks the calendar date button
  - Checks for a "Book" button at your preferred time
  - If found, clicks it and completes the booking
  - If not found, moves to the next available date immediately (no delays)
- **Key advantage**: Only tries dates that Tock shows as available, automatically skipping sold out or disabled dates

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
- date-fns (for calendar date manipulation)
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

**Automatic Mode (Optimized for Speed & Flexibility):**
1. **Initial Navigation**: Navigates to the search URL with your primary date when timer is scheduled
   - Example: `https://www.exploretock.com/restaurant-name/search?date=2025-11-07&size=2&time=20%3A00`

2. **Intelligent Timing**: Supports both pre-drop and post-drop refresh strategies
   - **Positive offset** (e.g., 200ms): Refreshes slightly before drop time (traditional approach)
   - **Negative offset** (e.g., -1500ms): Refreshes 1.5 seconds AFTER drop time
     - **Why this works**: Tock's backend needs time to process the reservation release
     - **Problem solved**: Prevents fetching stale/empty API responses
     - **Recommended**: -1500 to -2000ms for most restaurants

3. **Auto-Retry on Empty Slots**: If enabled, automatically retries if no slots found
   - **Immediate retries**: No delay between attempts (maximum speed)
   - **Example flow** (with 3 max attempts):
     ```
     9:00:01.5s → Refresh → No slots → Immediate retry
     9:00:01.7s → Refresh → No slots → Immediate retry
     9:00:01.9s → Refresh → Slots found! ✓
     ```

4. **Aggressive Slot Detection**: Optimized polling strategy
   - **First 5 seconds**: Checks every 100ms (10x per second)
   - **After 5 seconds**: Falls back to 500ms intervals
   - **MutationObserver**: Detects DOM changes instantly in parallel
   - **Total**: ~50 detection attempts in first 5 seconds

5. **Calendar Parsing**: Parses the Tock calendar HTML to find available dates
   - Looks for elements with `.ConsumerCalendar-day.is-available.is-in-month` classes
   - Extracts date from `aria-label` attributes (YYYY-MM-DD format)
   - Filters out disabled, sold out, or out-of-month dates

6. **Smart Date Filtering**: Compares desired dates against available dates
   - Desired dates determined by:
     - If calendar dates selected: Uses only those specific dates
     - If no calendar dates: Generates ±N days from primary date
   - Only tries dates that are both desired AND available
   - Skips dates that are sold out or disabled

7. **Fast Date Iteration**: For each available date:
   - Clicks the calendar date button directly in the DOM
   - Waits 300ms for page to update
   - Checks for "Book" button
   - If found, clicks it and completes booking
   - If not found, immediately moves to next date (no delays)

**Why this approach is fast:**
- Single page load instead of N page loads for N dates
- Direct calendar interaction (just like a human clicking dates)
- No delays between date attempts or retries
- Aggressive 100ms polling catches slots instantly
- Only tries dates that Tock's calendar shows as available
- Auto-refresh handles race conditions with server updates
- Fresh server data from strategic timing

**Why negative offset works better:** Tock's servers need ~500ms-2s to process the reservation release at drop time. Refreshing immediately at 9:00:00 often returns empty data because the API call completes before slots are ready. Waiting 1.5-2 seconds lets the backend finish processing, ensuring your first refresh gets real availability data.

### OpenTable Implementation
- Finds hidden `<select>` elements for party size, date, and time
- Converts between 24-hour and 12-hour time formats
- Navigates the react-day-picker calendar component
- Intelligently matches time slot buttons by parsing their text content
- Selects the exact or closest available time slot to your preference

### Scheduled Automation
- Uses Chrome Alarms API for precise timing
- Supports flexible timing (before OR after drop time)
- Auto-refresh on empty slots with immediate retries
- Tracks timer status and displays countdown in real-time
- Aggressive slot detection (100ms polling for first 5 seconds)

## Known Limitations

- OpenTable dropdown changes (party size, date, time) don't visually update the displayed time slots, but clicking still works correctly
- Icons have been removed from this extension. If you want to add them back, you would need to:
  1. Create icon files (16x16, 48x48, 128x128 PNG files)
  2. Place them in a `public/images` directory
  3. Update the manifest.json to reference these icons
  4. Update the webpack.config.js to copy the images folder

## License

MIT 