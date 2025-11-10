import React, { useEffect, useState } from 'react';
import PartySize from './PartySize';
import DatePicker from './DatePicker';
import DateSelectionCalendar from './DateSelectionCalendar';
import TimePicker from './TimePicker';
import { TockPreferences, ActiveTimer, Platform } from '../../types';
import { loadPreferences, savePreferences } from '../../utils/storage';
import { sendFillFormMessage, sendCancelTimerMessage, sendGetTimerStatusMessage } from '../../utils/messaging';
import { detectPlatform, getPlatformDisplayName } from '../../utils/platform';

const App: React.FC = () => {
  const [preferences, setPreferences] = useState<TockPreferences>({
    partySize: 2,
    date: new Date().toISOString().split('T')[0],
    time: '19:00',
    useFirstAvailableAfter: false,
    dateSelectionMode: 'range',
    maxDaysToScan: 7,
    selectedDates: [],
    autoSearchEnabled: false,
    dropTime: undefined,
    leadTimeMs: 200,
  });
  const [status, setStatus] = useState<string>('');
  const [isLoading, setIsLoading] = useState<boolean>(false);
  const [activeTimer, setActiveTimer] = useState<ActiveTimer | null>(null);
  const [countdown, setCountdown] = useState<string>('');
  const [platform, setPlatform] = useState<Platform | null>(null);

  // Load saved preferences, timer status, and detect platform on mount
  useEffect(() => {
    const fetchData = async () => {
      try {
        // Load preferences
        const savedPreferences = await loadPreferences();
        setPreferences(savedPreferences);

        // Get timer status
        const timerStatus = await sendGetTimerStatusMessage();
        setActiveTimer(timerStatus);

        // Detect platform from active tab URL
        const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
        const currentTab = tabs[0];
        if (currentTab?.url) {
          const detectedPlatform = detectPlatform(currentTab.url);
          setPlatform(detectedPlatform);
        }
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

        // Only update state if timer actually changed (prevents race condition)
        setActiveTimer(prevTimer => {
          // If both are null, no change needed
          if (!prevTimer && !timerStatus) return prevTimer;

          // If we have a timer but polling returns null, check status
          // Only keep timer if it's still being scheduled (prevents race condition)
          // Allow null through for other statuses (running/completed/failed/cancelled)
          if (prevTimer && !timerStatus) {
            if (prevTimer.status === 'scheduled') {
              return prevTimer;
            }
            return null;
          }

          // If we didn't have a timer and now we do, update
          if (!prevTimer && timerStatus) return timerStatus;

          // Compare timer states - only update if something changed
          const hasChanged =
            prevTimer!.alarmName !== timerStatus!.alarmName ||
            prevTimer!.status !== timerStatus!.status ||
            prevTimer!.scheduledTime !== timerStatus!.scheduledTime;

          return hasChanged ? timerStatus : prevTimer;
        });
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

  const handleUseFirstAvailableAfterChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    setPreferences(prev => ({ ...prev, useFirstAvailableAfter: e.target.checked }));
  };

  const handleMaxDaysToScanChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const value = parseInt(e.target.value);
    setPreferences(prev => ({ ...prev, maxDaysToScan: isNaN(value) ? 7 : value }));
  };

  const handleSelectedDatesChange = (dates: string[]) => {
    setPreferences(prev => ({ ...prev, selectedDates: dates }));
  };

  const handleDateSelectionModeChange = (mode: 'range' | 'specific') => {
    setPreferences(prev => ({
      ...prev,
      dateSelectionMode: mode,
      // Clear the data from the non-active mode
      ...(mode === 'range' ? { selectedDates: [] } : { maxDaysToScan: 7 })
    }));
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

  const handleAutoRefreshOnNoSlotsChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    setPreferences(prev => ({ ...prev, autoRefreshOnNoSlots: e.target.checked }));
  };

  const handleMaxRefreshRetriesChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const value = parseInt(e.target.value);
    setPreferences(prev => ({ ...prev, maxRefreshRetries: isNaN(value) ? 3 : value }));
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

  const pageTitle = platform
    ? `${getPlatformDisplayName(platform)} Reservation Filler`
    : 'Reservation Filler';

  return (
    <div className="p-4 w-full">
      <h1 className="text-xl font-bold mb-4 text-center text-gray-800">{pageTitle}</h1>

      <form onSubmit={handleSubmit} onKeyDown={handleKeyDown}>
        <PartySize value={preferences.partySize} onChange={handlePartySizeChange} />
        <DatePicker value={preferences.date} onChange={handleDateChange} />

        <div className="mb-4">
          <label className="flex items-center cursor-pointer">
            <input
              type="checkbox"
              checked={preferences.useFirstAvailableAfter || false}
              onChange={handleUseFirstAvailableAfterChange}
              className="mr-2 h-4 w-4 text-blue-600 rounded border-gray-300 focus:ring-blue-500"
            />
            <span className="text-sm font-medium text-gray-700">Use first available date</span>
          </label>

          {preferences.useFirstAvailableAfter && (
            <p className="text-xs text-amber-600 mt-2 ml-6 p-2 bg-amber-50 border border-amber-200 rounded">
              Note: Fallback dates only work for months at or after the primary date's month. Navigating to earlier months is not yet supported.
            </p>
          )}

          {preferences.useFirstAvailableAfter && (
            <div className="mt-2 ml-6 space-y-3">
              {/* Mode toggle */}
              <div className="flex gap-2 mb-3">
                <button
                  type="button"
                  onClick={() => handleDateSelectionModeChange('range')}
                  className={`flex-1 px-3 py-2 text-xs font-medium rounded border transition-colors ${
                    preferences.dateSelectionMode === 'range'
                      ? 'bg-blue-500 text-white border-blue-600'
                      : 'bg-white text-gray-700 border-gray-300 hover:bg-gray-50'
                  }`}
                >
                  Date Range
                </button>
                <button
                  type="button"
                  onClick={() => handleDateSelectionModeChange('specific')}
                  className={`flex-1 px-3 py-2 text-xs font-medium rounded border transition-colors ${
                    preferences.dateSelectionMode === 'specific'
                      ? 'bg-blue-500 text-white border-blue-600'
                      : 'bg-white text-gray-700 border-gray-300 hover:bg-gray-50'
                  }`}
                >
                  Specific Dates
                </button>
              </div>

              {/* Range mode */}
              {preferences.dateSelectionMode === 'range' && (
                <div>
                  <label className="block text-xs font-medium text-gray-600 mb-1">
                    Days to scan before/after primary
                  </label>
                  <input
                    type="number"
                    value={preferences.maxDaysToScan ?? 7}
                    onChange={handleMaxDaysToScanChange}
                    min="0"
                    max="30"
                    className="input text-sm w-20"
                  />
                  <p className="text-xs text-gray-500 mt-1">
                    {preferences.maxDaysToScan === 0
                      ? 'Only checks primary date'
                      : `Scans ±${preferences.maxDaysToScan ?? 7} days from primary date`}
                  </p>
                </div>
              )}

              {/* Specific dates mode */}
              {preferences.dateSelectionMode === 'specific' && (
                <div>
                  <DateSelectionCalendar
                    primaryDate={preferences.date}
                    selectedDates={preferences.selectedDates || []}
                    onSelectedDatesChange={handleSelectedDatesChange}
                  />
                  <p className="text-xs text-gray-500 mt-2">
                    {(preferences.selectedDates && preferences.selectedDates.length > 0)
                      ? `Will check ${preferences.selectedDates.length} selected ${preferences.selectedDates.length === 1 ? 'date' : 'dates'}`
                      : 'Select dates to check for availability'}
                  </p>
                </div>
              )}
            </div>
          )}
        </div>

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
              <div className="flex gap-2">
                <input
                  type="datetime-local"
                  value={preferences.dropTime || ''}
                  onChange={handleDropTimeChange}
                  className="input text-sm flex-1"
                  step="1"
                />
                <button
                  type="button"
                  onClick={() => {
                    const now = new Date();
                    const year = now.getFullYear();
                    const month = String(now.getMonth() + 1).padStart(2, '0');
                    const day = String(now.getDate()).padStart(2, '0');
                    const hours = String(now.getHours()).padStart(2, '0');
                    const minutes = String(now.getMinutes()).padStart(2, '0');
                    const seconds = String(now.getSeconds()).padStart(2, '0');
                    const formattedNow = `${year}-${month}-${day}T${hours}:${minutes}:${seconds}`;
                    setPreferences(prev => ({ ...prev, dropTime: formattedNow }));
                  }}
                  className="px-3 py-1 text-xs font-medium text-blue-600 hover:text-blue-800 hover:bg-blue-50 rounded border border-blue-300 hover:border-blue-400 transition-colors whitespace-nowrap"
                  aria-label="Set drop time to right now"
                >
                  Right Now
                </button>
              </div>
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Search Offset (ms)
              </label>
              <input
                type="number"
                value={preferences.leadTimeMs ?? 200}
                onChange={handleLeadTimeMsChange}
                min="-5000"
                max="5000"
                step="100"
                className="input text-sm"
              />
              <p className="text-xs text-gray-500 mt-1">
                Positive = search BEFORE drop (e.g., 200 = 200ms early)<br />
                Negative = search AFTER drop (e.g., -1500 = 1.5s late)<br />
                Range: -5000 to 5000ms
              </p>
            </div>

            <div className="border-t border-gray-200 pt-3">
              <label className="flex items-center cursor-pointer">
                <input
                  type="checkbox"
                  checked={preferences.autoRefreshOnNoSlots || false}
                  onChange={handleAutoRefreshOnNoSlotsChange}
                  className="mr-2 h-4 w-4 rounded border-gray-300 text-blue-600 focus:ring-blue-500"
                />
                <span className="text-sm font-medium text-gray-700">
                  Auto-refresh if no slots found
                </span>
              </label>
              <p className="text-xs text-gray-500 mt-1 ml-6">
                Automatically retry by refreshing the page if no available slots are detected
              </p>

              {preferences.autoRefreshOnNoSlots && (
                <div className="ml-6 mt-3">
                  <div>
                    <label className="block text-xs font-medium text-gray-600 mb-1">
                      Max Refresh Attempts
                    </label>
                    <input
                      type="number"
                      value={preferences.maxRefreshRetries ?? 3}
                      onChange={handleMaxRefreshRetriesChange}
                      min="1"
                      max="10"
                      className="input text-sm w-20"
                    />
                    <p className="text-xs text-gray-400 mt-1">How many times to refresh (1-10). Retries immediately with no delay.</p>
                  </div>
                </div>
              )}
            </div>

            {activeTimer?.status === 'scheduled' ? (
              <div className="space-y-2">
                <div className="p-3 bg-green-50 rounded-md">
                  <p className="text-sm font-medium text-green-800">Timer Active</p>
                  <p className="text-xs text-green-600 mt-1">Triggers in: {countdown}</p>
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
              </div>
            ) : activeTimer?.status === 'completed' ? (
              <div className="space-y-2">
                <div className="p-3 bg-green-50 rounded-md">
                  <p className="text-sm font-medium text-green-800">Completed Successfully!</p>
                </div>
                <button
                  type="button"
                  onClick={handleScheduleTimer}
                  className="btn w-full text-sm"
                >
                  Schedule New Timer
                </button>
              </div>
            ) : activeTimer?.status === 'failed' ? (
              <div className="space-y-2">
                <div className="p-3 bg-red-50 rounded-md">
                  <p className="text-sm font-medium text-red-800">Failed</p>
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
