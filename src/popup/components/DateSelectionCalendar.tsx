import React, { useState, useEffect, useRef } from 'react';
import {
  startOfMonth,
  endOfMonth,
  eachDayOfInterval,
  format,
  addMonths,
  subMonths,
  startOfWeek,
  endOfWeek,
  isSameMonth,
  parseISO
} from 'date-fns';

interface DateSelectionCalendarProps {
  primaryDate: string; // YYYY-MM-DD format
  selectedDates: string[];
  onSelectedDatesChange: (dates: string[]) => void;
}

const DateSelectionCalendar: React.FC<DateSelectionCalendarProps> = ({
  primaryDate,
  selectedDates,
  onSelectedDatesChange,
}) => {
  const primaryDateObj = parseISO(primaryDate);

  // Track which month we're currently viewing (start with primary date's month)
  const [viewingMonth, setViewingMonth] = useState<Date>(startOfMonth(primaryDateObj));

  // Drag selection state
  const [isDragging, setIsDragging] = useState<boolean>(false);
  const [dragMode, setDragMode] = useState<'select' | 'deselect'>('select');
  const [dragStartDate, setDragStartDate] = useState<string | null>(null);
  const [dragEndDate, setDragEndDate] = useState<string | null>(null);
  const originalSelectedDatesRef = useRef<string[]>([]);

  // Handle global mouse up to end drag selection
  useEffect(() => {
    const handleMouseUp = () => {
      if (isDragging) {
        setIsDragging(false);
        setDragStartDate(null);
        setDragEndDate(null);
        originalSelectedDatesRef.current = [];
      }
    };

    window.addEventListener('mouseup', handleMouseUp);
    return () => window.removeEventListener('mouseup', handleMouseUp);
  }, [isDragging]);

  const toggleDate = (dateStr: string) => {
    if (selectedDates.includes(dateStr)) {
      // Remove date
      onSelectedDatesChange(selectedDates.filter(d => d !== dateStr));
    } else {
      // Add date
      onSelectedDatesChange([...selectedDates, dateStr]);
    }
  };

  const handleMouseDown = (dateStr: string) => {
    setIsDragging(true);
    setDragStartDate(dateStr);
    setDragEndDate(dateStr);

    // Store the original selected dates at the start of drag
    originalSelectedDatesRef.current = [...selectedDates];

    // Determine drag mode based on current selection state
    const isCurrentlySelected = selectedDates.includes(dateStr);
    setDragMode(isCurrentlySelected ? 'deselect' : 'select');

    // Apply to first date
    toggleDate(dateStr);
  };

  const handleMouseEnter = (dateStr: string) => {
    if (!isDragging || !dragStartDate) return;

    // Update the current end date
    setDragEndDate(dateStr);

    // Parse dates
    const startDate = parseISO(dragStartDate);
    const endDate = parseISO(dateStr);

    // Determine the range (start to end, in either direction)
    const rangeStart = startDate < endDate ? startDate : endDate;
    const rangeEnd = startDate < endDate ? endDate : startDate;

    // Get all dates in the range
    const datesInRange = eachDayOfInterval({ start: rangeStart, end: rangeEnd })
      .map(date => format(date, 'yyyy-MM-dd'));

    // Start with original selected dates
    let newSelectedDates = [...originalSelectedDatesRef.current];

    if (dragMode === 'select') {
      // Add all dates in range
      datesInRange.forEach(date => {
        if (!newSelectedDates.includes(date)) {
          newSelectedDates.push(date);
        }
      });
    } else {
      // Remove all dates in range
      newSelectedDates = newSelectedDates.filter(date => !datesInRange.includes(date));
    }

    onSelectedDatesChange(newSelectedDates);
  };

  const goToPreviousMonth = () => {
    setViewingMonth(prev => subMonths(prev, 1));
  };

  const goToNextMonth = () => {
    setViewingMonth(prev => addMonths(prev, 1));
  };

  const monthStart = startOfMonth(viewingMonth);
  const monthEnd = endOfMonth(viewingMonth);

  // Get the calendar grid (includes leading/trailing days from adjacent months)
  const calendarStart = startOfWeek(monthStart);
  const calendarEnd = endOfWeek(monthEnd);

  const allDays = eachDayOfInterval({ start: calendarStart, end: calendarEnd });

  // Group days into weeks
  const weeks: Date[][] = [];
  for (let i = 0; i < allDays.length; i += 7) {
    weeks.push(allDays.slice(i, i + 7));
  }

  return (
    <div
      className="border border-gray-300 rounded-lg p-4 bg-white shadow-sm"
      style={{ userSelect: isDragging ? 'none' : 'auto' }}
    >
      {/* Info text with clear button */}
      <div className="flex items-center justify-between mb-3">
        <div className="text-xs text-gray-600">
          Click or drag to select dates. Selected: {selectedDates.length} {selectedDates.length === 1 ? 'date' : 'dates'}
        </div>
        {selectedDates.length > 0 && (
          <button
            type="button"
            onClick={() => onSelectedDatesChange([])}
            className="text-xs text-red-600 hover:text-red-800 hover:bg-red-50 px-2 py-1 rounded font-medium border border-red-200 hover:border-red-300 transition-colors"
            aria-label="Clear all selected dates"
          >
            Clear All
          </button>
        )}
      </div>

      {/* Month navigation header */}
      <div className="flex items-center justify-between mb-4">
        <button
          type="button"
          onClick={goToPreviousMonth}
          className="px-3 py-1 text-sm font-medium text-gray-700 hover:bg-gray-100 rounded border border-gray-300"
          aria-label="Previous month"
        >
          ← Prev
        </button>

        <div className="text-center font-semibold text-base text-gray-800">
          {format(viewingMonth, 'MMMM yyyy')}
        </div>

        <button
          type="button"
          onClick={goToNextMonth}
          className="px-3 py-1 text-sm font-medium text-gray-700 hover:bg-gray-100 rounded border border-gray-300"
          aria-label="Next month"
        >
          Next →
        </button>
      </div>

      {/* Day of week headers */}
      <div className="grid grid-cols-7 gap-2 mb-2">
        {['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].map(day => (
          <div key={day} className="text-xs text-gray-600 text-center font-semibold py-1">
            {day}
          </div>
        ))}
      </div>

      {/* Calendar grid */}
      <div className="space-y-2">
        {weeks.map((week, weekIdx) => (
          <div key={weekIdx} className="grid grid-cols-7 gap-2">
            {week.map(day => {
              const dateStr = format(day, 'yyyy-MM-dd');
              const isSelected = selectedDates.includes(dateStr);
              const isCurrentMonth = isSameMonth(day, viewingMonth);
              const isPrimaryDate = dateStr === primaryDate;

              // Determine if this date is in the current drag range
              let isInDragRange = false;
              if (isDragging && dragStartDate && dragEndDate) {
                const startDate = parseISO(dragStartDate);
                const endDate = parseISO(dragEndDate);
                const currentDate = parseISO(dateStr);
                const rangeStart = startDate < endDate ? startDate : endDate;
                const rangeEnd = startDate < endDate ? endDate : startDate;

                isInDragRange = currentDate >= rangeStart && currentDate <= rangeEnd;
              }

              return (
                <button
                  key={dateStr}
                  type="button"
                  onMouseDown={(e) => {
                    e.preventDefault(); // Prevent text selection
                    handleMouseDown(dateStr);
                  }}
                  onMouseEnter={() => handleMouseEnter(dateStr)}
                  className={`
                    text-sm h-10 rounded border-2 font-medium cursor-pointer
                    ${!isCurrentMonth && 'opacity-40'}
                    ${isPrimaryDate && !isSelected && !isInDragRange && 'border-blue-400 bg-blue-50 text-blue-700'}
                    ${isInDragRange && dragMode === 'select' && 'bg-blue-300 border-blue-400'}
                    ${isInDragRange && dragMode === 'deselect' && 'bg-red-200 border-red-300'}
                    ${!isInDragRange && isSelected
                      ? 'bg-blue-500 text-white border-blue-600 hover:bg-blue-600'
                      : !isInDragRange && 'border-gray-200 bg-white hover:bg-gray-50 hover:border-gray-300'
                    }
                    ${!isSelected && !isPrimaryDate && !isInDragRange && 'text-gray-700'}
                    transition-all
                  `}
                  aria-label={`${isSelected ? 'Deselect' : 'Select'} ${format(day, 'MMMM d, yyyy')}`}
                >
                  {format(day, 'd')}
                </button>
              );
            })}
          </div>
        ))}
      </div>
    </div>
  );
};

export default DateSelectionCalendar;
