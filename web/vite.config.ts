import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// A unique id for this build, baked into the bundle and shown in the app footer
// so it's obvious which build is actually running (a stale cached bundle shows an
// old id). `.git` isn't in the Docker build context, so default to the build
// timestamp; CI may override with a commit SHA via VITE_BUILD_ID.
const BUILD_ID = process.env.VITE_BUILD_ID || process.env.SOURCE_VERSION || new Date().toISOString();

// The frontend NEVER talks to market-data providers directly. All data flows
// through the backend API, proxied here in dev so the browser only ever calls
// same-origin "/api/*".
export default defineConfig({
  plugins: [react()],
  define: {
    __BUILD_ID__: JSON.stringify(BUILD_ID),
  },
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
