import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// The frontend NEVER talks to market-data providers directly. All data flows
// through the backend API, proxied here in dev so the browser only ever calls
// same-origin "/api/*".
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: process.env.VITE_API_TARGET || 'http://localhost:3001',
        changeOrigin: true,
      },
    },
  },
});
