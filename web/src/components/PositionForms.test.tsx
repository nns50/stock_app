import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { CloseModal } from './PositionForms';
import { ToastProvider } from './ToastContext';
import { client } from '../api/client';
import type { Position } from '../api/types';

function positionFixture(overrides: Partial<Position> = {}): Position {
  return {
    id: 7,
    assetType: 'stock',
    symbol: 'AAPL',
    side: 'long',
    quantity: 100,
    entryPrice: 90,
    entryDate: '2026-07-01',
    entryTime: null,
    fees: 0,
    optionType: null,
    strike: null,
    expiration: null,
    multiplier: 1,
    status: 'open',
    tags: ['live'],
    grade: null,
    notes: null,
    checklist: [],
    stopPrice: null,
    targetPrice: null,
    sourceIntentId: null,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    exits: [],
    remainingQuantity: 100,
    ...overrides,
  };
}

function renderModal(position: Position | null, onSaved = vi.fn()) {
  return render(
    <ToastProvider>
      <CloseModal position={position} onClose={vi.fn()} onSaved={onSaved} />
    </ToastProvider>,
  );
}

beforeEach(() => {
  vi.restoreAllMocks();
  localStorage.clear();
});

describe('CloseModal', () => {
  it('renders the position summary and the required confirmation phrase', () => {
    renderModal(positionFixture());
    expect(screen.getByText(/Close AAPL — real order/)).toBeInTheDocument();
    expect(screen.getByPlaceholderText('SELL 100 AAPL')).toBeInTheDocument();
  });

  it('flips the phrase to BUY for closing a short position', () => {
    renderModal(positionFixture({ side: 'short' }));
    expect(screen.getByPlaceholderText('BUY 100 AAPL')).toBeInTheDocument();
  });

  it('keeps "Close position" disabled until the exact phrase is typed (account id pre-filled, isolating the phrase gate)', async () => {
    localStorage.setItem('trade.accountId', JSON.stringify('ACC1'));
    renderModal(positionFixture());
    const input = screen.getByLabelText('type to confirm closing this position');
    const button = screen.getByRole('button', { name: 'Close position' });
    expect(button).toBeDisabled();

    await userEvent.type(input, 'SELL 100 AAP'); // one character short
    expect(button).toBeDisabled();

    await userEvent.clear(input);
    await userEvent.type(input, 'SELL 100 AAPL');
    expect(button).not.toBeDisabled();
  });

  it('also requires a Webull account id before allowing submission', async () => {
    renderModal(positionFixture());
    const input = screen.getByLabelText('type to confirm closing this position');
    await userEvent.type(input, 'SELL 100 AAPL');
    const button = screen.getByRole('button', { name: 'Close position' });
    expect(button).toBeDisabled(); // account id field is still empty

    await userEvent.type(screen.getByPlaceholderText('e.g. 12345678'), 'ACC1');
    expect(button).not.toBeDisabled();
  });

  it('calls client.closePosition with the position id, account id, and typed confirmation once armed', async () => {
    const spy = vi.spyOn(client, 'closePosition').mockResolvedValue({ ok: true, placed: true, reason: 'placed' });
    const onSaved = vi.fn();
    renderModal(positionFixture(), onSaved);

    await userEvent.type(screen.getByPlaceholderText('e.g. 12345678'), 'ACC1');
    await userEvent.type(screen.getByLabelText('type to confirm closing this position'), 'SELL 100 AAPL');
    await userEvent.click(screen.getByRole('button', { name: 'Close position' }));

    await waitFor(() => expect(spy).toHaveBeenCalledWith(7, 'ACC1', 'SELL 100 AAPL'));
    expect(await screen.findByText(/Close order placed/)).toBeInTheDocument();
    expect(onSaved).toHaveBeenCalled();
  });

  it('shows the failure reason and does NOT call onSaved when the close is blocked', async () => {
    vi.spyOn(client, 'closePosition').mockResolvedValue({
      ok: true,
      placed: false,
      reason: 'blocked',
      error: 'Could not cancel the resting bracket order first: order already terminal',
    });
    const onSaved = vi.fn();
    renderModal(positionFixture(), onSaved);

    await userEvent.type(screen.getByPlaceholderText('e.g. 12345678'), 'ACC1');
    await userEvent.type(screen.getByLabelText('type to confirm closing this position'), 'SELL 100 AAPL');
    await userEvent.click(screen.getByRole('button', { name: 'Close position' }));

    expect(await screen.findByText(/Could not cancel the resting bracket order first/)).toBeInTheDocument();
    expect(onSaved).not.toHaveBeenCalled();
  });

  it('resets the confirmation text and result when switching to a different position', () => {
    const { rerender } = render(
      <ToastProvider>
        <CloseModal position={positionFixture({ id: 1, symbol: 'AAPL' })} onClose={vi.fn()} onSaved={vi.fn()} />
      </ToastProvider>,
    );
    rerender(
      <ToastProvider>
        <CloseModal position={positionFixture({ id: 2, symbol: 'MSFT' })} onClose={vi.fn()} onSaved={vi.fn()} />
      </ToastProvider>,
    );
    expect(screen.getByPlaceholderText('SELL 100 MSFT')).toBeInTheDocument();
    expect((screen.getByLabelText('type to confirm closing this position') as HTMLInputElement).value).toBe('');
  });
});
