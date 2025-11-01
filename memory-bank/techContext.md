# Technical Context: Tock Reservation Form Filler

## Technologies Used

### Core Technologies
- **HTML/CSS/JavaScript**: Foundation of the extension
- **TypeScript**: For type safety and improved developer experience
- **ReactJS**: Frontend library for building the popup UI
- **Tailwind CSS**: Utility-first CSS framework for styling
- **Chrome Extension API**: For browser integration

### Development Tools
- **Webpack**: Module bundler
- **ESLint**: JavaScript/TypeScript linting
- **Prettier**: Code formatting
- **Jest**: Testing framework
- **React Testing Library**: Component testing

## Development Setup
- Node.js (v16+) environment
- npm or yarn package manager
- Chrome browser for testing
- VSCode with recommended extensions:
  - ESLint
  - Prettier
  - Chrome Debugger
  - TypeScript support

## Project Structure
```
tock-bot/
├── public/
│   ├── manifest.json
│   ├── icons/
│   └── ...
├── src/
│   ├── popup/
│   │   ├── components/
│   │   ├── hooks/
│   │   ├── App.tsx
│   │   └── index.tsx
│   ├── content/
│   │   ├── form-filler.ts
│   │   └── index.ts
│   ├── background/
│   │   └── index.ts
│   ├── utils/
│   │   ├── selectors.ts
│   │   ├── storage.ts
│   │   └── messaging.ts
│   └── types/
│       └── index.ts
├── dist/             # Build output
├── node_modules/
├── package.json
├── tsconfig.json
├── webpack.config.js
└── README.md
```

## Technical Constraints
- **Chrome Extension Manifest V3**: Must adhere to latest security model
- **Content Security Policy**: Restricted inline scripts and eval()
- **Cross-origin limitations**: Cannot access certain cross-origin resources
- **Chrome Storage API limits**: For storing preferences (not sensitive data)
- **DOM changes**: Must be resilient to Tock website structure changes

## Dependencies
- **@types/chrome**: TypeScript definitions for Chrome API
- **react**: UI library
- **react-dom**: React rendering for DOM
- **tailwindcss**: Utility CSS framework
- **date-fns**: Date manipulation library
- **webextension-polyfill**: Browser API compatibility

## Build & Deployment Process
1. Development build: `npm run dev` (watch mode)
2. Production build: `npm run build`
3. Local testing: Load unpacked extension from Chrome Extensions page
4. Distribution: Package as .zip for Chrome Web Store submission

## Testing Strategy
- Unit tests for utility functions
- Component tests for UI elements
- Integration tests for form filling logic
- Manual testing against various Tock-powered websites

## Browser Compatibility
- Primary: Chrome/Chromium-based browsers
- Chrome version 88+ (for full Manifest V3 support)

## Performance Considerations
- Minimize bundle size for faster popup loading
- Optimize DOM operations in content scripts
- Efficient messaging between components
- Throttle/debounce input event handlers 