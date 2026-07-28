// Applied before first paint (a classic, render-blocking script on purpose) so
// a saved light/dark choice never flashes the wrong theme. Lives as a real
// file rather than an inline <script> so the served app can carry a strict
// Content-Security-Policy (script-src 'self' — no 'unsafe-inline', no hashes
// to keep in sync with this text).
(function () {
  try {
    var t = localStorage.getItem('app.theme');
    if (t === 'light' || t === 'dark') document.documentElement.dataset.theme = t;
  } catch (e) {
    /* storage unavailable — keep the default theme */
  }
})();
