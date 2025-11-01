import React from 'react';

interface TimePickerProps {
  value: string;
  onChange: (value: string) => void;
}

const TimePicker: React.FC<TimePickerProps> = ({ value, onChange }) => {
  const handleChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
    onChange(e.target.value);
  };

  // Generate time options from 11:30 AM to 10:00 PM in 30-minute intervals
  const generateTimeOptions = () => {
    const options = [];
    const startHour = 11; // 11 AM
    const startMinute = 30; // 30 minutes
    const endHour = 22; // 10 PM

    for (let hour = startHour; hour <= endHour; hour++) {
      // For the first hour, start at the specified minute
      const firstMinute = hour === startHour ? startMinute : 0;
      
      for (let minute = firstMinute; minute < 60; minute += 30) {
        const hourString = hour.toString().padStart(2, '0');
        const minuteString = minute.toString().padStart(2, '0');
        const timeValue = `${hourString}:${minuteString}`;
        
        // Convert to 12-hour format for display
        const displayHour = hour > 12 ? hour - 12 : hour;
        const period = hour >= 12 ? 'PM' : 'AM';
        const displayTime = `${displayHour}:${minuteString} ${period}`;
        
        options.push({ value: timeValue, label: displayTime });
      }
    }
    
    return options;
  };

  const timeOptions = generateTimeOptions();

  return (
    <div className="mb-4">
      <label htmlFor="time" className="block text-sm font-medium text-gray-700 mb-1">
        Time
      </label>
      <select
        id="time"
        name="time"
        value={value}
        onChange={handleChange}
        className="form-input"
        aria-label="Select reservation time"
        tabIndex={0}
      >
        {timeOptions.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    </div>
  );
};

export default TimePicker; 