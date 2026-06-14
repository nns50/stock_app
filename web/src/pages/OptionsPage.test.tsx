import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import OptionsPage from './OptionsPage';
import { ProviderProvider } from '../components/ProviderContext';
import { client } from '../api/client';

beforeEach(() => {
  vi.restoreAllMocks();
  vi.spyOn(client, 'provider').mockResolvedValue({
    name: 'Mock',
    synthetic: true,
    configured: true,
    capabilities: { quotes: true, candles: true, options: true, fundamentals: false },
  } as never);
  vi.spyOn(client, 'expirations').mockResolvedValue({ expirations: [] } as never);
  vi.spyOn(client, 'settings').mockResolvedValue({} as never);
});

describe('OptionsPage', () => {
  it('renders the options workspace once the provider loads', async () => {
    render(
      <MemoryRouter>
        <ProviderProvider>
          <OptionsPage />
        </ProviderProvider>
      </MemoryRouter>,
    );
    expect(await screen.findByRole('heading', { name: 'Options' })).toBeInTheDocument();
    // The four workspace tabs are present.
    expect(screen.getByText('Entry scan')).toBeInTheDocument();
    expect(screen.getByText('Exit rules')).toBeInTheDocument();
  });
});
