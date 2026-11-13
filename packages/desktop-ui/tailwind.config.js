/** @type {import('tailwindcss').Config} */
export default {
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  darkMode: 'class',
  theme: {
    extend: {
      colors: {
        obsidian: {
          bg: '#18181b',
          canvas: '#18181b',
          card: '#242427',
          surface: '#242427',
          border: '#383842',
          hover: '#2c2c31',
          muted: '#3f3f46',
        },
        dark: {
          canvas: '#18181b',
          card: '#242427',
          border: '#383842',
          hover: '#2c2c31',
          muted: '#3f3f46',
        },
        brand: {
          emerald: '#10B981',
          purple: '#8B5CF6',
          violet: '#8B5CF6',
          indigo: '#8B5CF6',
          amber: '#F59E0B',
          cyan: '#06B6D4',
          gray: '#27272a',
          rose: '#EF4444',
        },
      },
      fontFamily: {
        sans: ['Inter', 'system-ui', '-apple-system', 'sans-serif'],
        mono: ['"JetBrains Mono"', 'monospace'],
      },
    },
  },
  plugins: [],
};
