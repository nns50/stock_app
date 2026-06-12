import { lazy, Suspense } from 'react';
import { Navigate, Route, Routes } from 'react-router-dom';
import { Layout } from './components/Layout';
import { ProviderProvider } from './components/ProviderContext';
import { Spinner } from './components/ui';

// Lazy-load pages so each (and its heavier deps like Recharts) ships as its own
// chunk, keeping the initial bundle small.
const ScreenerPage = lazy(() => import('./pages/ScreenerPage'));
const SymbolDetailPage = lazy(() => import('./pages/SymbolDetailPage'));
const OptionsPage = lazy(() => import('./pages/OptionsPage'));
const PositionsPage = lazy(() => import('./pages/PositionsPage'));
const JournalPage = lazy(() => import('./pages/JournalPage'));
const AlertsPage = lazy(() => import('./pages/AlertsPage'));

export default function App() {
  return (
    <ProviderProvider>
      <Layout>
        <Suspense fallback={<Spinner label="Loading…" />}>
          <Routes>
            <Route path="/" element={<Navigate to="/screener" replace />} />
            <Route path="/screener" element={<ScreenerPage />} />
            <Route path="/symbol/:symbol" element={<SymbolDetailPage />} />
            <Route path="/options" element={<OptionsPage />} />
            <Route path="/positions" element={<PositionsPage />} />
            <Route path="/journal" element={<JournalPage />} />
            <Route path="/alerts" element={<AlertsPage />} />
            <Route path="*" element={<Navigate to="/screener" replace />} />
          </Routes>
        </Suspense>
      </Layout>
    </ProviderProvider>
  );
}
