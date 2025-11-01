# System Patterns: Tock Reservation Form Filler

## Architecture Overview
The Tock Form Filler extension follows a standard Chrome extension architecture with:

1. **Popup UI Component**
   - React-based user interface for collecting user inputs
   - Tailwind CSS for responsive styling
   - Form state management using React hooks

2. **Background Service**
   - Manages communication between popup and content scripts
   - Handles extension lifecycle events
   - Stores user preferences (non-sensitive)

3. **Content Scripts**
   - Injects into Tock pages to interact with the DOM
   - Identifies and fills form elements
   - Triggers search action
   - Provides visual feedback during automation

## Design Patterns

### Component Structure
- **Atomic Design Pattern**: Building UI from small, reusable components to larger organisms
- **Container/Presentational Pattern**: Separating state management from UI rendering

### State Management
- **React Hooks**: Using useState and useEffect for local state management
- **Chrome Storage API**: For persistent preferences between sessions

### DOM Interaction
- **Observer Pattern**: Watching for DOM changes on Tock pages
- **Facade Pattern**: Abstracting complex DOM interactions behind simple interfaces

## Data Flow
```
┌─────────────┐      ┌─────────────────┐      ┌────────────────┐
│  Popup UI   │◄────►│ Background.js   │◄────►│ Content Script │
└─────────────┘      └─────────────────┘      └────────────────┘
       ▲                                              │
       │                                              ▼
       │                                      ┌────────────────┐
       └──────────────────────────────────────┤   Tock DOM     │
                                              └────────────────┘
```

## Key Technical Decisions
1. **Manifest V3**: Following latest Chrome extension standards
2. **React & Tailwind**: Modern, responsive UI development
3. **TypeScript**: For type safety and better developer experience
4. **Modular Architecture**: Separating concerns for better maintainability

## Component Relationships
- **Popup Component**: Manages form inputs and triggers form-filling action
- **FormFiller Service**: Core logic for DOM interaction and form manipulation
- **Feedback Component**: Provides visual feedback during automation process
- **Storage Service**: Manages user preferences persistence

## Critical Implementation Paths
1. **Tock DOM Analysis**: Understanding and adapting to Tock's form structure
2. **Form Element Identification**: Reliable selectors for different Tock sites
3. **Input Automation**: Natural-feeling input events for form filling
4. **Error Handling**: Graceful recovery from unexpected DOM changes
5. **User Feedback**: Clear visual indicators of automation progress 