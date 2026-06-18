import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, act } from '@testing-library/react';
import { GlobalLogTrade, OPEN_LOG_TRADE_EVENT } from './GlobalLogTrade';
import { client } from '../api/client';

beforeEach(() => {
  vi.restoreAllMocks();
  vi.spyOn(client, 'settings').mockResolvedValue({} as never);
  vi.spyOn(client, 'journalTags').mockResolvedValue({ tags: [] } as never);
});

describe('GlobalLogTrade', () => {
  it('stays closed until the open event, then shows the Log-trade form', () => {
    render(<GlobalLogTrade />);
    expect(screen.queryByRole('heading', { name: 'Log trade' })).toBeNull();
    act(() => {
      window.dispatchEvent(new Event(OPEN_LOG_TRADE_EVENT));
    });
    expect(screen.getByRole('heading', { name: 'Log trade' })).toBeInTheDocument();
  });

  it('prefills the symbol when the open event carries one', () => {
    render(<GlobalLogTrade />);
    act(() => {
      window.dispatchEvent(new CustomEvent(OPEN_LOG_TRADE_EVENT, { detail: { symbol: 'nvda' } }));
    });
    expect(screen.getByPlaceholderText('AAPL')).toHaveValue('NVDA');
  });
});
