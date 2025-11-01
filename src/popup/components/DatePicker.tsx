import React from 'react';

interface DatePickerProps {
  value: string;
  onChange: (value: string) => void;
}

const DatePicker: React.FC<DatePickerProps> = ({ value, onChange }) => {
  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    onChange(e.target.value);
  };

  return (
    <div className="mb-4">
      <label htmlFor="date" className="block text-sm font-medium text-gray-700 mb-1">
        Date
      </label>
      <input
        type="date"
        id="date"
        name="date"
        value={value}
        onChange={handleChange}
        min={new Date().toISOString().split('T')[0]}
        className="form-input"
        aria-label="Select reservation date"
        tabIndex={0}
      />
    </div>
  );
};

export default DatePicker; 