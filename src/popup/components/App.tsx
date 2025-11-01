import React, { useEffect, useState } from 'react';
import PartySize from './PartySize';
import DatePicker from './DatePicker';
import TimePicker from './TimePicker';
import { TockPreferences, ActiveTimer } from '../../types';
import { loadPreferences, savePreferences } from '../../utils/storage';
import { sendFillFormMessage, sendCancelTimerMessage, sendGetTimerStatusMessage } from '../../utils/messaging';

const App: React.FC = () => {
  const [preferences, setPreferences] = useState<TockPreferences>({
    partySize: 2,
    date: new Date().toISOString().split('T')[0],
    time: '19:00',
    autoSearchEnabled: false,
    dropTime: undefined,
    leadTimeMs: 200,
    maxRetries: 10,
    retryIntervalSeconds: 1,
  });
  const [status, setStatus] = useState<string>('');
  const [isLoading, setIsLoading] = useState<boolean>(false);
  const [activeTimer, setActiveTimer] = useState<ActiveTimer | null>(null);
  const [countdown, setCountdown] = useState<string>('');

  // Load saved preferences and timer status on mount
  useEffect(() => {
    const fetchData = async () => {
      try {
        const savedPreferences = await loadPreferences();
        setPreferences(savedPreferences);

        const timerStatus = await sendGetTimerStatusMessage();
        setActiveTimer(timerStatus);
      } catch (error) {
        console.error('Error loading data:', error);
        setStatus('Error loading saved preferences');
      }
    };

    fetchData();
  }, []);

  // Update countdown every second when there's an active timer
  useEffect(() => {
    if (!activeTimer || activeTimer.status !== 'scheduled') {
      setCountdown('');
      return;
    }

    const updateCountdown = () => {
      const scheduledTime = new Date(activeTimer.scheduledTime).getTime();
      const now = Date.now();
      const diff = scheduledTime - now;

      if (diff <= 0) {
        setCountdown('Triggering...');
        return;
      }

      const hours = Math.floor(diff / 1000 / 60 / 60);
      const minutes = Math.floor((diff / 1000 / 60) % 60);
      const seconds = Math.floor((diff / 1000) % 60);
      const milliseconds = Math.floor(diff % 1000);

      if (hours > 0) {
        setCountdown(`${hours}h ${minutes}m ${seconds}s`);
      } else if (minutes > 0) {
        setCountdown(`${minutes}m ${seconds}s`);
      } else {
        setCountdown(`${seconds}.${Math.floor(milliseconds / 100)}s`);
      }
    };

    updateCountdown();
    const interval = setInterval(updateCountdown, 100);

    return () => clearInterval(interval);
  }, [activeTimer]);

  // Poll for timer status updates
  useEffect(() => {
    const pollTimerStatus = async () => {
      try {
        const timerStatus = await sendGetTimerStatusMessage();
        setActiveTimer(timerStatus);
      } catch (error) {
        console.error('Error polling timer status:', error);
      }
    };

    const interval = setInterval(pollTimerStatus, 1000);
    return () => clearInterval(interval);
  }, []);

  const handlePartySizeChange = (value: number) => {
    setPreferences(prev => ({ ...prev, partySize: value }));
  };

  const handleDateChange = (value: string) => {
    setPreferences(prev => ({ ...prev, date: value }));
  };

  const handleTimeChange = (value: string) => {
    setPreferences(prev => ({ ...prev, time: value }));
  };

  const handleAutoSearchEnabledChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    setPreferences(prev => ({ ...prev, autoSearchEnabled: e.target.checked }));
  };

  const handleDropTimeChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    setPreferences(prev => ({ ...prev, dropTime: e.target.value }));
  };

  const handleLeadTimeMsChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const value = parseInt(e.target.value);
    setPreferences(prev => ({ ...prev, leadTimeMs: isNaN(value) ? 200 : value }));
  };

  const handleMaxRetriesChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    setPreferences(prev => ({ ...prev, maxRetries: parseInt(e.target.value) || 10 }));
  };

  const handleRetryIntervalChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    setPreferences(prev => ({ ...prev, retryIntervalSeconds: parseInt(e.target.value) || 1 }));
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setStatus('');
    setIsLoading(true);

    try {
      // Save preferences
      await savePreferences(preferences);

      // Send message to content script
      await sendFillFormMessage(preferences);

      setStatus('Form filling initiated!');
    } catch (error) {
      console.error('Error:', error);
      setStatus(`Error: ${error instanceof Error ? error.message : 'Unknown error'}`);
    } finally {
      setIsLoading(false);
    }
  };

  const handleScheduleTimer = async (e: React.FormEvent) => {
    e.preventDefault();
    setStatus('');
    setIsLoading(true);

    try {
      // Validate drop time
      if (!preferences.dropTime) {
        setStatus('Error: Please specify a drop time');
        setIsLoading(false);
        return;
      }

      // Save preferences
      await savePreferences(preferences);

      // Get current tab ID
      const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
      const tabId = tabs[0]?.id;

      if (!tabId) {
        setStatus('Error: No active tab found');
        setIsLoading(false);
        return;
      }

      // Send schedule message to background script
      const response = await chrome.runtime.sendMessage({
        type: 'SCHEDULE_TIMER',
        payload: { preferences, tabId }
      });

      if (response.success) {
        setActiveTimer(response.timer);
        setStatus('Timer scheduled successfully!');
      } else {
        setStatus(`Error: ${response.error || 'Failed to schedule timer'}`);
      }
    } catch (error) {
      console.error('Error:', error);
      setStatus(`Error: ${error instanceof Error ? error.message : 'Unknown error'}`);
    } finally {
      setIsLoading(false);
    }
  };

  const handleCancelTimer = async () => {
    try {
      await sendCancelTimerMessage();
      setActiveTimer(null);
      setStatus('Timer cancelled');
    } catch (error) {
      console.error('Error cancelling timer:', error);
      setStatus(`Error: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      handleSubmit(e as unknown as React.FormEvent);
    }
  };

  return (
    <div className="p-4 w-full">
      <h1 className="text-xl font-bold mb-4 text-center text-gray-800">Tock Reservation Filler</h1>

      <form onSubmit={handleSubmit} onKeyDown={handleKeyDown}>
        <PartySize value={preferences.partySize} onChange={handlePartySizeChange} />
        <DatePicker value={preferences.date} onChange={handleDateChange} />
        <TimePicker value={preferences.time} onChange={handleTimeChange} />

        <button
          type="submit"
          disabled={isLoading || (activeTimer?.status === 'scheduled')}
          className="btn mt-4"
          aria-label="Fill reservation form"
          tabIndex={0}
        >
          {isLoading ? (
            <span className="flex items-center justify-center">
              <svg className="animate-spin -ml-1 mr-2 h-4 w-4 text-white" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
              </svg>
              Processing...
            </span>
          ) : 'Fill Reservation Form Now'}
        </button>
      </form>

      {/* Automatic Search Section */}
      <div className="mt-6 pt-6 border-t border-gray-200">
        <div className="mb-4">
          <label className="flex items-center cursor-pointer">
            <input
              type="checkbox"
              checked={preferences.autoSearchEnabled || false}
              onChange={handleAutoSearchEnabledChange}
              className="mr-2 h-4 w-4 text-blue-600 rounded border-gray-300 focus:ring-blue-500"
            />
            <span className="text-sm font-medium text-gray-700">Enable Automatic Search</span>
          </label>
        </div>

        {preferences.autoSearchEnabled && (
          <div className="space-y-3">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Reservation Drop Time (Local Time)
              </label>
              <input
                type="datetime-local"
                value={preferences.dropTime || ''}
                onChange={handleDropTimeChange}
                className="input text-sm"
                step="1"
              />
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Search Before Drop (ms)
              </label>
              <input
                type="number"
                value={preferences.leadTimeMs ?? 200}
                onChange={handleLeadTimeMsChange}
                min="0"
                max="5000"
                step="100"
                className="input text-sm"
              />
              <p className="text-xs text-gray-500 mt-1">How many milliseconds before drop time to search (0-5000)</p>
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Maximum Retry Attempts
              </label>
              <input
                type="number"
                value={preferences.maxRetries || 10}
                onChange={handleMaxRetriesChange}
                min="1"
                max="100"
                className="input text-sm"
              />
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Retry Interval (seconds)
              </label>
              <input
                type="number"
                value={preferences.retryIntervalSeconds || 1}
                onChange={handleRetryIntervalChange}
                min="0.1"
                max="60"
                step="0.1"
                className="input text-sm"
              />
            </div>

            {activeTimer?.status === 'scheduled' ? (
              <div className="space-y-2">
                <div className="p-3 bg-green-50 rounded-md">
                  <p className="text-sm font-medium text-green-800">Timer Active</p>
                  <p className="text-xs text-green-600 mt-1">Triggers in: {countdown}</p>
                  <p className="text-xs text-green-600">Attempt: {activeTimer.currentAttempt + 1} / {activeTimer.maxRetries}</p>
                </div>
                <button
                  type="button"
                  onClick={handleCancelTimer}
                  className="btn-secondary w-full text-sm"
                >
                  Cancel Timer
                </button>
              </div>
            ) : activeTimer?.status === 'running' ? (
              <div className="p-3 bg-blue-50 rounded-md">
                <p className="text-sm font-medium text-blue-800">Running...</p>
                <p className="text-xs text-blue-600 mt-1">Attempt: {activeTimer.currentAttempt + 1} / {activeTimer.maxRetries}</p>
              </div>
            ) : activeTimer?.status === 'completed' ? (
              <div className="space-y-2">
                <div className="p-3 bg-green-50 rounded-md">
                  <p className="text-sm font-medium text-green-800">Completed Successfully!</p>
                </div>
                <button
                  type="button"
                  onClick={handleCancelTimer}
                  className="btn w-full text-sm"
                >
                  Schedule New Timer
                </button>
              </div>
            ) : activeTimer?.status === 'failed' ? (
              <div className="space-y-2">
                <div className="p-3 bg-red-50 rounded-md">
                  <p className="text-sm font-medium text-red-800">Failed After {activeTimer.maxRetries} Attempts</p>
                </div>
                <button
                  type="button"
                  onClick={handleCancelTimer}
                  className="btn w-full text-sm"
                >
                  Schedule New Timer
                </button>
              </div>
            ) : (
              <button
                type="button"
                onClick={handleScheduleTimer}
                disabled={isLoading || !preferences.dropTime}
                className="btn w-full text-sm"
              >
                Schedule Timer
              </button>
            )}
          </div>
        )}
      </div>

      {status && (
        <div className="mt-4 p-2 text-center text-sm font-medium rounded-md bg-blue-50 text-blue-700">
          {status}
        </div>
      )}
    </div>
  );
};

export default App;
