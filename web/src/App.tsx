import { lazy, Suspense } from 'react';
import { Navigate, Route, Routes } from 'react-router-dom';
import { Layout } from './components/Layout';
import { ProviderProvider } from './components/ProviderContext';
import { AlertsProvider } from './components/AlertsContext';
import { ToastProvider } from './components/ToastContext';
import { ConfirmProvider } from './components/ConfirmContext';
import { ThemeProvider } from './components/ThemeContext';
import { AuthGate } from './components/AuthGate';
import { Spinner } from './components/ui';

// Lazy-load pages so each (and its heavier deps like Recharts) ships as its own
// chunk, keeping the initial bundle small.
const ScreenerPage = lazy(() => import('./pages/ScreenerPage'));
const SymbolDetailPage = lazy(() => import('./pages/SymbolDetailPage'));
const OptionsPage = lazy(() => import('./pages/OptionsPage'));
const PositionsPage = lazy(() => import('./pages/PositionsPage'));
const JournalPage = lazy(() => import('./pages/JournalPage'));
const AlertsPage = lazy(() => import('./pages/AlertsPage'));
const AboutPage = lazy(() => import('./pages/AboutPage'));
const WatchlistPage = lazy(() => import('./pages/WatchlistPage'));
const DashboardPage = lazy(() => import('./pages/DashboardPage'));
const SettingsPage = lazy(() => import('./pages/SettingsPage'));
const TradePage = lazy(() => import('./pages/TradePage'));
const AutoTradePage = lazy(() => import('./pages/AutoTradePage'));

export default function App() {
  return (
    <ThemeProvider>
      <ToastProvider>
        <AuthGate>
          <ConfirmProvider>
            <ProviderProvider>
              <AlertsProvider>
                <Layout>
                  <Suspense fallback={<Spinner label="Loading…" />}>
                    <Routes>
                      <Route path="/" element={<Navigate to="/today" replace />} />
                      <Route path="/today" element={<DashboardPage />} />
                      <Route path="/screener" element={<ScreenerPage />} />
                      <Route path="/watchlist" element={<WatchlistPage />} />
                      <Route path="/symbol/:symbol" element={<SymbolDetailPage />} />
                      <Route path="/options" element={<OptionsPage />} />
                      <Route path="/trade" element={<TradePage />} />
                      <Route path="/positions" element={<PositionsPage />} />
                      <Route path="/journal" element={<JournalPage />} />
                      <Route path="/alerts" element={<AlertsPage />} />
                      <Route path="/auto-trade" element={<AutoTradePage />} />
                      <Route path="/settings" element={<SettingsPage />} />
                      <Route path="/about" element={<AboutPage />} />
                      <Route path="*" element={<Navigate to="/today" replace />} />
                    </Routes>
                  </Suspense>
                </Layout>
              </AlertsProvider>
            </ProviderProvider>
          </ConfirmProvider>
        </AuthGate>
      </ToastProvider>
    </ThemeProvider>
  );
}
