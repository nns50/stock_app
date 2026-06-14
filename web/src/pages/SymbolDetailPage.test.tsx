import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import SymbolDetailPage from './SymbolDetailPage';
import { client } from '../api/client';

beforeEach(() => {
  vi.restoreAllMocks();
  vi.spyOn(client, 'watchlist').mockResolvedValue({ symbols: [] } as never);
  vi.spyOn(client, 'symbolDetail').mockReturnValue(new Promise(() => {}) as never);
});

describe('SymbolDetailPage', () => {
  it('renders the symbol header from the route while the chart loads', () => {
    render(
      <MemoryRouter initialEntries={['/symbol/AAPL']}>
        <Routes>
          <Route path="/symbol/:symbol" element={<SymbolDetailPage />} />
        </Routes>
      </MemoryRouter>,
    );
    expect(screen.getByRole('heading', { name: 'AAPL' })).toBeInTheDocument();
    expect(screen.getByText(/Loading chart/)).toBeInTheDocument();
  });
});
