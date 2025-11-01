/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ['./src/**/*.{ts,tsx,html}'],
  theme: {
    extend: {
      colors: {
        primary: {
          DEFAULT: '#2A2AE9',
          dark: '#0F0FC0',
        },
      },
    },
  },
  plugins: [],
}; 