// Floating Timer UI - Content Script
// This script injects a floating timer overlay on all pages when a timer is active

import { ActiveTimer } from '../types';

class FloatingTimer {
  private container: HTMLDivElement | null = null;
  private shadowRoot: ShadowRoot | null = null;
  private intervalId: number | null = null;
  private pollIntervalId: number | null = null;
  private currentTimer: ActiveTimer | null = null;
  private isMinimized: boolean = false;
  private isDragging: boolean = false;
  private dragOffset: { x: number; y: number } = { x: 0, y: 0 };

  constructor() {
    this.init();
  }

  private async init() {
    // Start polling for timer status
    await this.checkTimerStatus();
    this.pollIntervalId = window.setInterval(() => this.checkTimerStatus(), 1000);
  }

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

  private drag(e: MouseEvent) {
    if (!this.isDragging) return;

    const timer = this.shadowRoot?.getElementById('floating-timer');
    if (timer) {
      timer.style.right = 'auto';
      timer.style.left = `${e.clientX - this.dragOffset.x}px`;
      timer.style.top = `${e.clientY - this.dragOffset.y}px`;
    }
  }

  private endDrag() {
    this.isDragging = false;
  }

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

  private async cancelTimer() {
    try {
      await chrome.runtime.sendMessage({ type: 'CANCEL_TIMER' });
      this.destroy();
    } catch (error) {
      console.error('Failed to cancel timer:', error);
    }
  }

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

// Initialize the floating timer
new FloatingTimer();
