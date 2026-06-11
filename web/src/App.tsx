import { Navigate, Route, Routes } from 'react-router-dom';
import { Layout } from './components/Layout';
import { ProviderProvider } from './components/ProviderContext';
import ScreenerPage from './pages/ScreenerPage';
import SymbolDetailPage from './pages/SymbolDetailPage';
import OptionsPage from './pages/OptionsPage';
import PositionsPage from './pages/PositionsPage';
import JournalPage from './pages/JournalPage';

export default function App() {
  return (
    <ProviderProvider>
      <Layout>
        <Routes>
          <Route path="/" element={<Navigate to="/screener" replace />} />
          <Route path="/screener" element={<ScreenerPage />} />
          <Route path="/symbol/:symbol" element={<SymbolDetailPage />} />
          <Route path="/options" element={<OptionsPage />} />
          <Route path="/positions" element={<PositionsPage />} />
          <Route path="/journal" element={<JournalPage />} />
          <Route path="*" element={<Navigate to="/screener" replace />} />
        </Routes>
      </Layout>
    </ProviderProvider>
  );
}
