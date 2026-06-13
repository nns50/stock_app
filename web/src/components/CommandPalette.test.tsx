import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { CommandPalette, OPEN_PALETTE_EVENT } from './CommandPalette';
import { client } from '../api/client';

beforeEach(() => {
  vi.spyOn(client, 'universe').mockResolvedValue({
    symbols: [{ symbol: 'AAPL', name: 'Apple Inc.' }],
  } as never);
  vi.spyOn(client, 'watchlist').mockResolvedValue({ symbols: ['TSLA'] } as never);
});

function openPalette() {
  render(
    <MemoryRouter>
      <CommandPalette />
    </MemoryRouter>,
  );
  act(() => {
    window.dispatchEvent(new Event(OPEN_PALETTE_EVENT));
  });
}

describe('CommandPalette', () => {
  it('is hidden until opened, then filters nav items', async () => {
    openPalette();
    const input = await screen.findByPlaceholderText(/Jump to/);
    fireEvent.change(input, { target: { value: 'posi' } });
    expect(screen.getByText('Positions')).toBeInTheDocument();
    expect(screen.queryByText('Screener')).toBeNull();
  });

  it('finds a symbol by ticker and shows its name', async () => {
    openPalette();
    const input = await screen.findByPlaceholderText(/Jump to/);
    await waitFor(() => expect(client.universe).toHaveBeenCalled());
    fireEvent.change(input, { target: { value: 'aapl' } });
    await waitFor(() => expect(screen.getByText('AAPL')).toBeInTheDocument());
    expect(screen.getByText('Apple Inc.')).toBeInTheDocument();
  });
});
