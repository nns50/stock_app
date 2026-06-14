import { lazy, Suspense } from 'react';
import { Navigate, Route, Routes } from 'react-router-dom';
import { Layout } from './components/Layout';
import { ProviderProvider } from './components/ProviderContext';
import { AlertsProvider } from './components/AlertsContext';
import { ToastProvider } from './components/ToastContext';
import { ConfirmProvider } from './components/ConfirmContext';
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

export default function App() {
  return (
    <ToastProvider>
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
                  <Route path="/positions" element={<PositionsPage />} />
                  <Route path="/journal" element={<JournalPage />} />
                  <Route path="/alerts" element={<AlertsPage />} />
                  <Route path="/about" element={<AboutPage />} />
                  <Route path="*" element={<Navigate to="/today" replace />} />
                </Routes>
              </Suspense>
            </Layout>
          </AlertsProvider>
        </ProviderProvider>
      </ConfirmProvider>
    </ToastProvider>
  );
}
