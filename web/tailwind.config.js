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
          850: '#0e141f',
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
      boxShadow: {
        card: '0 1px 2px 0 rgb(0 0 0 / 0.30), 0 1px 3px 0 rgb(0 0 0 / 0.18)',
        pop: '0 12px 34px -12px rgb(0 0 0 / 0.55)',
        glow: '0 0 0 1px rgb(56 189 248 / 0.15), 0 10px 28px -10px rgb(56 189 248 / 0.28)',
      },
      fontFamily: {
        mono: ['ui-monospace', 'SFMono-Regular', 'Menlo', 'monospace'],
      },
    },
  },
  plugins: [],
};
