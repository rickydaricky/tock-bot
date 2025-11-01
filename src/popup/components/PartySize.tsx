import React from 'react';

interface PartySizeProps {
  value: number;
  onChange: (value: number) => void;
}

const PartySize: React.FC<PartySizeProps> = ({ value, onChange }) => {
  const handleDecrement = () => {
    if (value > 1) {
      onChange(value - 1);
    }
  };

  const handleIncrement = () => {
    if (value < 12) {
      onChange(value + 1);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent, action: 'increment' | 'decrement') => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      action === 'increment' ? handleIncrement() : handleDecrement();
    }
  };

  return (
    <div className="mb-4">
      <label htmlFor="partySize" className="block text-sm font-medium text-gray-700 mb-1">
        Party Size
      </label>
      <div className="flex items-center">
        <button
          type="button"
          onClick={handleDecrement}
          onKeyDown={(e) => handleKeyDown(e, 'decrement')}
          disabled={value <= 1}
          aria-label="Decrease party size"
          tabIndex={0}
          className="inline-flex items-center p-2 border border-gray-300 rounded-l-md bg-gray-50 text-gray-500 hover:bg-gray-100 focus:outline-none focus:ring-2 focus:ring-primary disabled:opacity-50 disabled:cursor-not-allowed"
        >
          <svg xmlns="http://www.w3.org/2000/svg" className="h-5 w-5" viewBox="0 0 20 20" fill="currentColor">
            <path fillRule="evenodd" d="M3 10a1 1 0 011-1h12a1 1 0 110 2H4a1 1 0 01-1-1z" clipRule="evenodd" />
          </svg>
        </button>
        <div className="flex-1 text-center py-2 border-t border-b border-gray-300 bg-white">
          <span className="text-lg font-medium" id="partySize">
            {value} {value === 1 ? 'guest' : 'guests'}
          </span>
        </div>
        <button
          type="button"
          onClick={handleIncrement}
          onKeyDown={(e) => handleKeyDown(e, 'increment')}
          disabled={value >= 12}
          aria-label="Increase party size"
          tabIndex={0}
          className="inline-flex items-center p-2 border border-gray-300 rounded-r-md bg-gray-50 text-gray-500 hover:bg-gray-100 focus:outline-none focus:ring-2 focus:ring-primary disabled:opacity-50 disabled:cursor-not-allowed"
        >
          <svg xmlns="http://www.w3.org/2000/svg" className="h-5 w-5" viewBox="0 0 20 20" fill="currentColor">
            <path fillRule="evenodd" d="M10 3a1 1 0 011 1v5h5a1 1 0 110 2h-5v5a1 1 0 11-2 0v-5H4a1 1 0 110-2h5V4a1 1 0 011-1z" clipRule="evenodd" />
          </svg>
        </button>
      </div>
    </div>
  );
};

export default PartySize; 