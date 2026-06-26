import React from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import App from './App';
import './index.css';

// Self-heal after a deploy: pages are code-split (see App.tsx `lazy`), so a
// browser still holding the previous build's index can request a chunk hash that
// no longer exists (404) and Vite fires `vite:preloadError`. Reload once to pull
// the fresh index (served no-cache) and its current chunks. The short throttle
// stops a reload loop if a chunk is genuinely, persistently unavailable.
window.addEventListener('vite:preloadError', () => {
  const KEY = 'vite:preloadReloadAt';
  const last = Number(sessionStorage.getItem(KEY) || 0);
  if (Date.now() - last < 10_000) return;
  sessionStorage.setItem(KEY, String(Date.now()));
  window.location.reload();
});

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <BrowserRouter>
      <App />
    </BrowserRouter>
  </React.StrictMode>,
);
