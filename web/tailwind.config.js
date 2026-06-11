/** @type {import('tailwindcss').Config} */
export default {
  darkMode: 'class',
  content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}'],
  theme: {
    extend: {
      colors: {
        // Dark-mode-friendly dense dashboard palette
        ink: {
          900: '#0b0f17',
          800: '#111722',
          700: '#1a2230',
          600: '#243042',
          500: '#33415a',
        },
        accent: {
          DEFAULT: '#38bdf8',
          muted: '#0ea5e9',
        },
        bull: '#22c55e',
        bear: '#ef4444',
      },
      fontFamily: {
        mono: ['ui-monospace', 'SFMono-Regular', 'Menlo', 'monospace'],
      },
    },
  },
  plugins: [],
};
