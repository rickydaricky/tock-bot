/**
 * Floating Timer UI — content script.
 *
 * Single responsibility: render an in-page, draggable countdown overlay that
 * shows how long until the scheduled reservation "drop" fires, then flip to a
 * live status readout (running / booked / failed) once the alarm goes off.
 *
 * Role in the system: this is a pure *view*. It owns no timing logic — the
 * authoritative alarm/state lives in the background service worker
 * (`src/background/index.ts`). This script polls that worker once per second
 * (`GET_TIMER_STATUS`) and reflects whatever it reports, and forwards the one
 * user action it exposes (`CANCEL_TIMER`) back to the worker. Because it is
 * injected into every page, it must be visually and functionally inert unless
 * a timer is actually active.
 *
 * Key export: none. The module self-instantiates a single `FloatingTimer` on
 * load (see bottom of file); the class is intentionally not exported.
 *
 * Style/isolation note: the overlay lives inside a closed Shadow DOM so host
 * page CSS can never bleed in and restyle (or hide) the timer, and vice versa.
 */

import { ActiveTimer } from '../types';

/**
 * Draggable, self-updating countdown/status widget injected into the page.
 *
 * Lifecycle: constructed once on script load; `init()` kicks off a 1s poll of
 * the background worker. The DOM (`container`/`shadowRoot`) is created lazily
 * the first time a `scheduled` timer is seen and torn down by `destroy()` when
 * the timer clears, is cancelled, or auto-hides after a terminal status.
 */
class FloatingTimer {
  /** Host element appended to `document.body`; null while no UI is mounted. */
  private container: HTMLDivElement | null = null;
  /** Closed shadow root that walls the widget off from host-page CSS. */
  private shadowRoot: ShadowRoot | null = null;
  /** Reserved handle for a per-second countdown tick (currently unused — the countdown is driven by the poll loop instead). */
  private intervalId: number | null = null;
  /** Handle for the 1s poll of the background worker's timer status. */
  private pollIntervalId: number | null = null;
  /** Last status snapshot from the worker; drives what/whether we render. */
  private currentTimer: ActiveTimer | null = null;
  private isMinimized: boolean = false;
  private isDragging: boolean = false;
  /** Cursor offset within the widget at mousedown, so dragging tracks the grab point rather than snapping the corner to the cursor. */
  private dragOffset: { x: number; y: number } = { x: 0, y: 0 };

  constructor() {
    this.init();
  }

  /**
   * Begin the poll loop. Runs one immediate check so the overlay can appear
   * without waiting a full second, then re-checks every 1000ms. 1s cadence is
   * enough because the countdown only renders whole-second resolution.
   */
  private async init() {
    // Start polling for timer status
    await this.checkTimerStatus();
    this.pollIntervalId = window.setInterval(() => this.checkTimerStatus(), 1000);
  }

  /**
   * Poll the background worker and reconcile the UI with its reported state.
   *
   * The status object is the single source of truth. Behavior by status:
   *  - `scheduled`: mount the UI the first time (or when the alarm identity
   *    changes) and refresh the countdown; keyed on `alarmName` so replacing
   *    one scheduled timer with another rebuilds cleanly.
   *  - `running`/`completed`/`failed`: swap the countdown for a status banner.
   *  - anything else / null (no active timer): tear the UI down.
   *
   * The try/catch swallows "Extension context invalidated" — expected and
   * benign when the service worker restarts or the extension reloads while
   * this content script is still alive; we simply skip this tick.
   */
  private async checkTimerStatus() {
    try {
      const status = await chrome.runtime.sendMessage({ type: 'GET_TIMER_STATUS' });

      if (status && status.status === 'scheduled') {
        if (!this.currentTimer || this.currentTimer.alarmName !== status.alarmName) {
          this.currentTimer = status;
          this.createUI();
        }
        this.updateCountdown();
      } else if (status && (status.status === 'running' || status.status === 'completed' || status.status === 'failed')) {
        this.currentTimer = status;
        this.updateStatusDisplay();
      } else {
        // No active timer
        if (this.container) {
          this.destroy();
        }
        this.currentTimer = null;
      }
    } catch (error) {
      // Extension context invalidated or other error
      console.log('Floating timer: Unable to get timer status');
    }
  }

  /**
   * Lazily build and mount the widget. Idempotent: no-ops if already mounted.
   * Uses a *closed* shadow root so neither host-page styles nor host-page
   * scripts can reach in and restyle/hide the timer.
   */
  private createUI() {
    if (this.container) return;

    // Create container with shadow DOM for style isolation
    this.container = document.createElement('div');
    this.container.id = 'tock-floating-timer-container';
    this.shadowRoot = this.container.attachShadow({ mode: 'closed' });

    // Inject styles
    const styles = document.createElement('style');
    styles.textContent = this.getStyles();
    this.shadowRoot.appendChild(styles);

    // Create timer UI
    const timerUI = document.createElement('div');
    timerUI.id = 'floating-timer';
    timerUI.innerHTML = this.getTimerHTML();
    this.shadowRoot.appendChild(timerUI);

    document.body.appendChild(this.container);

    // Add event listeners
    this.setupEventListeners();
  }

  /**
   * Scoped stylesheet for the widget. Lives inside the shadow root, so these
   * selectors never leak to (or collide with) the host page. The status-*
   * classes recolor the card gradient per terminal state (see
   * updateStatusDisplay). z-index is the 32-bit max so the overlay sits above
   * any host content, including full-screen checkout modals.
   */
  private getStyles(): string {
    return `
      #floating-timer {
        position: fixed;
        top: 20px;
        right: 20px;
        z-index: 2147483647;
        font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, sans-serif;
        font-size: 14px;
        user-select: none;
      }

      .timer-card {
        background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
        border-radius: 12px;
        box-shadow: 0 10px 40px rgba(0, 0, 0, 0.3);
        color: white;
        min-width: 280px;
        overflow: hidden;
        animation: slideIn 0.3s ease-out;
      }

      .timer-card.minimized {
        min-width: auto;
      }

      @keyframes slideIn {
        from {
          opacity: 0;
          transform: translateY(-20px);
        }
        to {
          opacity: 1;
          transform: translateY(0);
        }
      }

      .timer-header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        padding: 12px 16px;
        background: rgba(0, 0, 0, 0.1);
        cursor: move;
      }

      .timer-title {
        display: flex;
        align-items: center;
        gap: 8px;
        font-weight: 600;
        font-size: 13px;
      }

      .timer-icon {
        font-size: 16px;
      }

      .header-buttons {
        display: flex;
        gap: 8px;
      }

      .header-btn {
        background: rgba(255, 255, 255, 0.2);
        border: none;
        color: white;
        width: 24px;
        height: 24px;
        border-radius: 6px;
        cursor: pointer;
        display: flex;
        align-items: center;
        justify-content: center;
        font-size: 14px;
        transition: background 0.2s;
      }

      .header-btn:hover {
        background: rgba(255, 255, 255, 0.3);
      }

      .timer-body {
        padding: 16px;
      }

      .timer-body.hidden {
        display: none;
      }

      .countdown {
        text-align: center;
        margin-bottom: 12px;
      }

      .countdown-value {
        font-size: 36px;
        font-weight: 700;
        font-variant-numeric: tabular-nums;
        letter-spacing: 2px;
      }

      .countdown-label {
        font-size: 11px;
        opacity: 0.8;
        text-transform: uppercase;
        letter-spacing: 1px;
        margin-top: 4px;
      }

      .timer-info {
        background: rgba(0, 0, 0, 0.15);
        border-radius: 8px;
        padding: 12px;
        font-size: 12px;
      }

      .info-row {
        display: flex;
        justify-content: space-between;
        margin-bottom: 6px;
      }

      .info-row:last-child {
        margin-bottom: 0;
      }

      .info-label {
        opacity: 0.8;
      }

      .info-value {
        font-weight: 500;
      }

      .cancel-btn {
        width: 100%;
        margin-top: 12px;
        padding: 10px;
        background: rgba(255, 255, 255, 0.2);
        border: 1px solid rgba(255, 255, 255, 0.3);
        color: white;
        border-radius: 8px;
        cursor: pointer;
        font-size: 13px;
        font-weight: 500;
        transition: all 0.2s;
      }

      .cancel-btn:hover {
        background: rgba(255, 255, 255, 0.3);
      }

      .status-running {
        background: linear-gradient(135deg, #f093fb 0%, #f5576c 100%);
      }

      .status-completed {
        background: linear-gradient(135deg, #4facfe 0%, #00f2fe 100%);
      }

      .status-failed {
        background: linear-gradient(135deg, #fa709a 0%, #fee140 100%);
      }

      .status-message {
        text-align: center;
        padding: 20px;
        font-size: 16px;
        font-weight: 600;
      }

      .status-icon {
        font-size: 32px;
        margin-bottom: 8px;
      }
    `;
  }

  /**
   * Initial "scheduled" markup: the countdown view with drop-time/lead-time
   * rows and a cancel button. IDs here are the contract that updateCountdown,
   * setupEventListeners, and toggleMinimize look up by getElementById — keep
   * them in sync with those methods. `updateStatusDisplay` later replaces
   * `#timer-body`'s contents wholesale with the status banner.
   */
  private getTimerHTML(): string {
    return `
      <div class="timer-card" id="timer-card">
        <div class="timer-header" id="timer-header">
          <div class="timer-title">
            <span class="timer-icon">⏱️</span>
            <span>Reservation Timer</span>
          </div>
          <div class="header-buttons">
            <button class="header-btn" id="minimize-btn" title="Minimize">−</button>
            <button class="header-btn" id="close-btn" title="Close">×</button>
          </div>
        </div>
        <div class="timer-body" id="timer-body">
          <div class="countdown">
            <div class="countdown-value" id="countdown-value">--:--:--</div>
            <div class="countdown-label">Until Drop Time</div>
          </div>
          <div class="timer-info">
            <div class="info-row">
              <span class="info-label">Drop Time:</span>
              <span class="info-value" id="drop-time">--</span>
            </div>
            <div class="info-row">
              <span class="info-label">Lead Time:</span>
              <span class="info-value" id="lead-time">--</span>
            </div>
          </div>
          <button class="cancel-btn" id="cancel-btn">Cancel Timer</button>
        </div>
      </div>
    `;
  }

  /**
   * Wire up the header buttons and drag behavior.
   *
   * Gotcha: mousemove/mouseup are bound to `document`, not the widget, so a
   * fast drag that outruns the cursor doesn't drop the gesture when the
   * pointer leaves the small header. `startDrag` is bound to the header only,
   * so dragging is initiated by grabbing the title bar.
   */
  private setupEventListeners() {
    if (!this.shadowRoot) return;

    // Minimize button
    const minimizeBtn = this.shadowRoot.getElementById('minimize-btn');
    minimizeBtn?.addEventListener('click', () => this.toggleMinimize());

    // Close button
    const closeBtn = this.shadowRoot.getElementById('close-btn');
    closeBtn?.addEventListener('click', () => this.destroy());

    // Cancel button
    const cancelBtn = this.shadowRoot.getElementById('cancel-btn');
    cancelBtn?.addEventListener('click', () => this.cancelTimer());

    // Drag functionality
    const header = this.shadowRoot.getElementById('timer-header');
    header?.addEventListener('mousedown', (e) => this.startDrag(e));
    document.addEventListener('mousemove', (e) => this.drag(e));
    document.addEventListener('mouseup', () => this.endDrag());
  }

  /**
   * Collapse to just the header (hide the body) or expand back, toggling the
   * minimize button glyph between − and +. Purely a display concern; polling
   * and the countdown keep running while minimized.
   */
  private toggleMinimize() {
    this.isMinimized = !this.isMinimized;
    const body = this.shadowRoot?.getElementById('timer-body');
    const card = this.shadowRoot?.getElementById('timer-card');
    const btn = this.shadowRoot?.getElementById('minimize-btn');

    if (body && card && btn) {
      if (this.isMinimized) {
        body.classList.add('hidden');
        card.classList.add('minimized');
        btn.textContent = '+';
      } else {
        body.classList.remove('hidden');
        card.classList.remove('minimized');
        btn.textContent = '−';
      }
    }
  }

  /**
   * Begin a drag. Bails if the mousedown landed on a button so clicking
   * minimize/close doesn't also start dragging. Records the cursor's offset
   * within the widget so `drag` can keep that grab point under the cursor.
   */
  private startDrag(e: MouseEvent) {
    if ((e.target as HTMLElement).closest('button')) return;

    this.isDragging = true;
    const timer = this.shadowRoot?.getElementById('floating-timer');
    if (timer) {
      const rect = timer.getBoundingClientRect();
      this.dragOffset = {
        x: e.clientX - rect.left,
        y: e.clientY - rect.top
      };
    }
  }

  /**
   * Reposition the widget to follow the cursor while dragging. Clears the
   * default `right: 20px` anchor (setting `right: auto`) and switches to
   * explicit left/top, otherwise a right+left conflict would pin the width.
   */
  private drag(e: MouseEvent) {
    if (!this.isDragging) return;

    const timer = this.shadowRoot?.getElementById('floating-timer');
    if (timer) {
      timer.style.right = 'auto';
      timer.style.left = `${e.clientX - this.dragOffset.x}px`;
      timer.style.top = `${e.clientY - this.dragOffset.y}px`;
    }
  }

  /** End the current drag gesture. Global mouseup ensures this fires even if the release happens off the widget. */
  private endDrag() {
    this.isDragging = false;
  }

  /**
   * Recompute and render the H:MM:SS countdown to `dropTime`, plus the
   * drop-time and lead-time info rows. Called every poll tick while status is
   * `scheduled`.
   *
   * `dropTime`/`scheduledTime` arrive as ISO strings; `new Date()` parses them.
   * Lead time is derived as `dropTime - scheduledTime` (per the ActiveTimer
   * contract, `scheduledTime` is when the alarm fires = dropTime - leadTime),
   * so this shows how far *ahead* of the drop the bot intends to fire. If the
   * countdown has already hit zero we bail without touching the DOM, leaving
   * the last value on screen until the worker reports the `running` status.
   */
  private updateCountdown() {
    if (!this.currentTimer || !this.shadowRoot) return;

    const dropTime = new Date(this.currentTimer.dropTime);
    const now = new Date();
    const diff = dropTime.getTime() - now.getTime();

    if (diff <= 0) {
      // Timer has reached zero
      return;
    }

    const hours = Math.floor(diff / (1000 * 60 * 60));
    const minutes = Math.floor((diff % (1000 * 60 * 60)) / (1000 * 60));
    const seconds = Math.floor((diff % (1000 * 60)) / 1000);

    const countdownValue = this.shadowRoot.getElementById('countdown-value');
    if (countdownValue) {
      countdownValue.textContent = `${hours.toString().padStart(2, '0')}:${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`;
    }

    // Update drop time display
    const dropTimeEl = this.shadowRoot.getElementById('drop-time');
    if (dropTimeEl) {
      dropTimeEl.textContent = dropTime.toLocaleTimeString([], {
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit'
      });
    }

    // Calculate and display lead time
    const leadTimeEl = this.shadowRoot.getElementById('lead-time');
    if (leadTimeEl && this.currentTimer.scheduledTime) {
      const scheduledTime = new Date(this.currentTimer.scheduledTime);
      const leadMs = dropTime.getTime() - scheduledTime.getTime();
      leadTimeEl.textContent = `${leadMs}ms`;
    }
  }

  /**
   * Replace the countdown body with a terminal/active status banner and
   * recolor the card. `running` stays up (the attempt is in flight);
   * `completed` and `failed` are terminal and self-destruct after 5s so the
   * overlay clears itself without needing another poll to null it out.
   *
   * Note: the `setTimeout(destroy, 5000)` can re-fire on subsequent polls
   * while the worker still reports the same terminal status, but `destroy()`
   * is idempotent so the extra timers are harmless no-ops.
   */
  private updateStatusDisplay() {
    if (!this.currentTimer || !this.shadowRoot) return;

    const card = this.shadowRoot.getElementById('timer-card');
    const body = this.shadowRoot.getElementById('timer-body');

    if (!card || !body) return;

    let statusClass = '';
    let icon = '';
    let message = '';

    switch (this.currentTimer.status) {
      case 'running':
        statusClass = 'status-running';
        icon = '⚡';
        message = 'Attempting to book...';
        break;
      case 'completed':
        statusClass = 'status-completed';
        icon = '✅';
        message = 'Booking successful!';
        // Auto-hide after 5 seconds
        setTimeout(() => this.destroy(), 5000);
        break;
      case 'failed':
        statusClass = 'status-failed';
        icon = '❌';
        message = 'Booking failed';
        // Auto-hide after 5 seconds
        setTimeout(() => this.destroy(), 5000);
        break;
    }

    card.className = `timer-card ${statusClass}`;
    body.innerHTML = `
      <div class="status-message">
        <div class="status-icon">${icon}</div>
        <div>${message}</div>
      </div>
    `;
  }

  /**
   * User pressed "Cancel Timer": ask the background worker to clear the alarm,
   * then tear down the UI. We destroy optimistically after the message
   * resolves rather than waiting for the next poll to report no active timer.
   */
  private async cancelTimer() {
    try {
      await chrome.runtime.sendMessage({ type: 'CANCEL_TIMER' });
      this.destroy();
    } catch (error) {
      console.error('Failed to cancel timer:', error);
    }
  }

  /**
   * Full teardown: stop both intervals, detach the host element from the DOM,
   * and null out all references so a future `scheduled` status rebuilds from
   * scratch. Idempotent and safe to call repeatedly (guards on each field), so
   * the auto-hide timers and the no-timer branch can all funnel through here.
   *
   * GOTCHA: this also clears `pollIntervalId`, so once the UI has been
   * mounted and then torn down (timer cleared, cancelled, or terminal-status
   * auto-hide) this instance stops polling entirely — a subsequent timer will
   * not re-mount until the page reloads and re-instantiates FloatingTimer.
   * The `if (this.container)` guard in `checkTimerStatus`'s no-timer branch is
   * what keeps the poll loop alive during the *pre-first-timer* idle period
   * (container still null, so destroy is skipped).
   */
  private destroy() {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
    if (this.pollIntervalId) {
      clearInterval(this.pollIntervalId);
      this.pollIntervalId = null;
    }
    if (this.container && this.container.parentNode) {
      this.container.parentNode.removeChild(this.container);
    }
    this.container = null;
    this.shadowRoot = null;
    this.currentTimer = null;
  }
}

// Module side effect: instantiate exactly one timer per page load. The
// constructor starts the poll loop immediately; the widget stays invisible
// until the background worker reports an active timer. No reference is kept —
// the instance lives via its interval callbacks and DOM event listeners.
new FloatingTimer();
