# Tock Reservation Form Filler

A Chrome extension that automatically fills in and submits the reservation form on Tock-powered restaurant reservation websites.

## Features

- Automatically fills in party size
- Sets your preferred date
- Selects your desired time
- Submits the search form with one click
- Saves your preferences for future use

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

1. Navigate to any Tock-powered restaurant reservation page
2. Click the Tock Form Filler extension icon in your browser toolbar
3. Enter your desired party size, date, and time
4. Click "Fill Reservation Form"
5. The extension will automatically fill the form and submit it

## Development

- `npm run dev` - Builds the extension in development mode with watch mode enabled
- `npm run build` - Builds the extension for production

## Project Structure

- `public/` - Static assets and manifest.json
- `src/` - Source code
  - `popup/` - React components for the popup UI
  - `content/` - Content scripts that interact with the Tock website
  - `background/` - Background service worker
  - `utils/` - Utility functions
  - `types/` - TypeScript type definitions

## Technologies Used

- TypeScript
- React
- Tailwind CSS
- Chrome Extensions API
- Webpack

## Note

Icons have been removed from this extension. If you want to add them back, you would need to:
1. Create icon files (16x16, 48x48, 128x128 PNG files)
2. Place them in a `public/images` directory
3. Update the manifest.json to reference these icons
4. Update the webpack.config.js to copy the images folder

## License

MIT 