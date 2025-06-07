# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

This is a Tauri 2.0 desktop application that schedules and executes Claude CLI commands at specified times through iTerm on macOS. The app provides a GUI for configuring scheduled Claude command execution with countdown timer functionality and automatic rate limit retry support.

## Essential Commands

```bash
# Development
npm run tauri dev       # Start Tauri in development mode (opens native window)
npm run dev            # Start only the Vite dev server (browser preview on port 1420)
npm run preview        # Preview production build

# Building
npm run build          # Build frontend assets (required before Tauri build)
npm run tauri build    # Build the complete Tauri application
npm run tauri:build    # Alternative: Build complete Tauri application

# Formatting
npm run fmt            # Format TypeScript/CSS files with Prettier
npm run tauri:fmt      # Format Rust code with cargo fmt

# Version Management
npm run pretauri:build # Auto-updates version based on current date (YY.M.D format)

# Rust-specific commands (run in src-tauri/)
cargo build            # Build Rust backend
cargo check            # Check Rust code for errors
cargo clippy           # Run Rust linter
```

## Development Workflow

1. **Initial Setup**: Run `npm install` to install dependencies
2. **Development**: Use `npm run tauri dev` for full-stack development with hot reload
3. **Frontend-only Development**: Use `npm run dev` to work on UI without Tauri wrapper
4. **Before Building**: Run `npm run build` to ensure frontend compiles without errors
5. **Production Build**: Run `npm run tauri:build` (automatically updates version)
6. **Code Quality**: Run `npm run fmt` and `npm run tauri:fmt` before committing

## Architecture

### Frontend (React + TypeScript + Vite)
- **src/App.tsx**: Main component containing all UI logic and state management
  - Manages execution settings (time, directory, options, command)
  - Implements countdown timer using setInterval
  - Communicates with Rust backend via Tauri's invoke API
  - Handles real-time terminal output updates via event listeners
  - Persists settings to localStorage for convenience
  - Japanese UI with countdown display (時間/分/秒)

### Backend (Rust)
- **src-tauri/src/lib.rs**: Core Tauri application logic
  - `execute_claude_command`: Main command that schedules and executes Claude CLI
  - `stop_execution`: Manages execution cancellation
  - `check_iterm_status`: Verifies iTerm installation and running state
  - Uses AppleScript via `osascript` to control iTerm terminal
  - Implements rate limit detection and automatic retry logic
  - Date/time parsing with chrono crate
  - Real-time terminal output monitoring
  - Library named `tauri_claude_code_runner_lib` to avoid Windows conflicts

### Key Implementation Details

1. **AppleScript Integration**: The app generates AppleScript dynamically to:
   - Open iTerm and create a new tab or window
   - Navigate to the specified directory
   - Execute the Claude command with `--dangerously-skip-permissions` flag
   - Monitor terminal output for rate limit messages

2. **IPC Communication**: Frontend-backend communication uses Tauri commands:
   ```typescript
   await invoke("execute_claude_command", {
     executionTime: string,      // HH:MM format
     targetDirectory: string,
     claudeOptions: string,
     claudeCommand: string,
     autoRetryOnRateLimit: boolean,
     useNewWindow: boolean       // iTerm window preference
   });
   ```

3. **Event System**:
   - `execution-started`: Fired when Claude command begins execution
   - `terminal-output`: Streams terminal output to frontend for display
   - `rate-limit-retry-scheduled`: Notifies frontend when rate limit retry is scheduled

4. **Rate Limit Handling**:
   - Detects "Claude usage limit reached" and "reset at" patterns
   - Requires 3 consecutive occurrences of "reset at" for confirmation
   - Calculates wait duration until rate limit reset
   - Auto-retry mode: waits and sends "continue" command automatically at next hour:01
   - Manual mode: terminates execution when rate limit is detected (3 consecutive)
   - Shows remaining time in Japanese format (e.g., "2時間 30分 15秒")
   - Monitors terminal output every 60 seconds for status updates

5. **Time Handling**: 
   - Frontend uses native JavaScript Date for UI
   - Backend parses RFC3339 timestamps using chrono
   - Supports 12-hour (am/pm) time format parsing
   - Version format: YY.M.D (without zero-padding)

6. **iTerm Window Management**:
   - Supports both new window and new tab modes
   - New window: Creates a fresh iTerm window for each execution
   - New tab: Uses existing window (creates new window if none exists)
   - User preference is persisted in localStorage

## Development Environment

### TypeScript Configuration
- Strict mode enabled with additional checks:
  - `noUnusedLocals`
  - `noUnusedParameters`
  - `noFallthroughCasesInSwitch`
- Target: ES2020
- Module resolution: bundler
- JSX: react-jsx

### Build Configuration
- Vite dev server runs on fixed port 1420
- HMR enabled with automatic host detection
- Ignores `src-tauri` directory during watch mode
- Tailwind CSS v4 with both PostCSS and Vite plugins

### Dependencies
- **Frontend**: React 18, TypeScript, Tailwind CSS v4, Vite 6
- **Backend**: Tauri 2.0, chrono (date/time), tokio (async), serde (serialization)
- **Tauri Plugins**: dialog, opener

## Important Implementation Notes

- The app requires iTerm to be installed on macOS
- Accessibility permissions must be granted for AppleScript control
- Version updates automatically on build using YY.M.D format (via update-version.js)
- Settings are persisted to localStorage (except execution time)
- No ESLint configuration - only Prettier for formatting
- TypeScript is in strict mode - handle all nullable values properly
- The default Claude options include `--model opus`
- UI language is Japanese with appropriate countdown formatting
- The app uses Tailwind CSS v4 with both PostCSS and Vite plugins
- React 18 with TypeScript for the frontend

## Key Files and Their Roles

- **src/App.tsx**: Single-page React application with all UI components and state
- **src-tauri/src/lib.rs**: Rust backend with Tauri commands and AppleScript integration
- **src-tauri/tauri.conf.json**: Tauri configuration (window size, app metadata)
- **update-version.js**: Script that auto-generates version from current date
- **vite.config.ts**: Frontend build configuration with fixed port 1420
- **src-tauri/Cargo.toml**: Rust dependencies and library configuration

## State Management

- **Frontend State** (React hooks):
  - `executionTime`: Selected time for execution (HH:MM format)
  - `targetDirectory`: Directory where Claude command will run
  - `claudeOptions`: CLI options (default: "--model opus")
  - `claudeCommand`: The actual command to execute
  - `autoRetryOnRateLimit`: Toggle for automatic retry behavior
  - `useNewITermWindow`: Toggle for iTerm window mode
  - `terminalOutput`: Real-time terminal output display
  - `countdownTime`: Remaining time until execution
  - `iTermStatus`: iTerm installation and running state

- **Backend State** (Arc<Mutex<T>>):
  - `is_running`: Tracks if execution is active
  - `cancel_flag`: Allows cancellation of scheduled execution

## Testing Strategy

No automated tests are configured. Manual testing approach:
1. Test scheduling with various time inputs
2. Verify iTerm integration and AppleScript execution
3. Test rate limit detection and retry mechanisms
4. Verify cancellation functionality
5. Test persistence of settings across app restarts
6. Test iTerm status detection (installed/running)
7. Test both iTerm window modes (new window vs new tab)

## Execution Completion Detection

The app detects command completion by monitoring "esc to interrupt" in terminal output:
- When "esc to interrupt" disappears for 3 consecutive checks (3 minutes), execution is considered complete
- Processing time is calculated from start to first absence detection
- This approach works reliably for Claude Code CLI which shows this prompt during execution
