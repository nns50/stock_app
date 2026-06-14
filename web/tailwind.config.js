/** @type {import('tailwindcss').Config} */
export default {
  darkMode: 'class',
  content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}'],
  theme: {
    extend: {
      colors: {
        // Surface + text scales resolve to CSS variables so the whole app can
        // re-theme (light/dark) by swapping those vars — see src/index.css.
        ink: {
          900: 'var(--ink-900)',
          850: 'var(--ink-850)',
          800: 'var(--ink-800)',
          700: 'var(--ink-700)',
          600: 'var(--ink-600)',
          500: 'var(--ink-500)',
        },
        // Override the slate text shades actually used (100–600) with theme
        // vars; the rest of Tailwind's slate scale is untouched.
        slate: {
          100: 'var(--txt-100)',
          200: 'var(--txt-200)',
          300: 'var(--txt-300)',
          400: 'var(--txt-400)',
          500: 'var(--txt-500)',
          600: 'var(--txt-600)',
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
