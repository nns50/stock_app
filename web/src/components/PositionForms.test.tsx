import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { CloseModal, ExitModal, JournalEditModal } from './PositionForms';
import { ToastProvider } from './ToastContext';
import { ConfirmProvider } from './ConfirmContext';
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

describe('ExitModal — state re-sync between positions', () => {
  it('does not bleed exit price/notes from one position into the next, and defaults quantity to the new remaining', async () => {
    const { rerender } = render(
      <ToastProvider>
        <ExitModal
          position={positionFixture({ id: 1, symbol: 'AAPL', remainingQuantity: 100 })}
          onClose={vi.fn()}
          onSaved={vi.fn()}
        />
      </ToastProvider>,
    );

    // Fill an exit for position A.
    await userEvent.type(screen.getByLabelText('Exit price'), '50');
    await userEvent.type(screen.getByLabelText('Notes'), 'scalp');
    expect((screen.getByLabelText('Exit price') as HTMLInputElement).value).toBe('50');

    // Switch to a different position — the modal stays mounted, so without a
    // re-sync the price/notes would bleed over and Quantity would stay at A's.
    rerender(
      <ToastProvider>
        <ExitModal
          position={positionFixture({ id: 2, symbol: 'MSFT', remainingQuantity: 25 })}
          onClose={vi.fn()}
          onSaved={vi.fn()}
        />
      </ToastProvider>,
    );

    expect((screen.getByLabelText('Exit price') as HTMLInputElement).value).toBe('');
    expect((screen.getByLabelText('Notes') as HTMLInputElement).value).toBe('');
    expect((screen.getByLabelText('Quantity') as HTMLInputElement).value).toBe('25');
  });
});

function renderJournalModal(position: Position | null, onSaved = vi.fn()) {
  return render(
    <ToastProvider>
      <ConfirmProvider>
        <JournalEditModal position={position} onClose={() => {}} onSaved={onSaved} />
      </ConfirmProvider>
    </ToastProvider>,
  );
}

describe('JournalEditModal — Webull account (2026-07-17, multi-account fix)', () => {
  it('pre-fills the account field from the position, blank when unset', () => {
    renderJournalModal(positionFixture({ accountId: 'ACC1_CASH' }));
    expect(screen.getByPlaceholderText(/INDIVIDUAL_CASH/)).toHaveValue('ACC1_CASH');
  });

  it('saves the edited account id', async () => {
    const spy = vi.spyOn(client, 'updatePosition').mockResolvedValue(positionFixture());
    renderJournalModal(positionFixture({ id: 7, accountId: 'CASH' }));

    fireEvent.change(screen.getByPlaceholderText(/INDIVIDUAL_CASH/), { target: { value: 'MARGIN' } });
    fireEvent.click(screen.getByText('Save'));

    await waitFor(() => expect(spy).toHaveBeenCalledWith(7, expect.objectContaining({ accountId: 'MARGIN' })));
  });

  it('saves a blanked-out account id as null, not an empty string', async () => {
    const spy = vi.spyOn(client, 'updatePosition').mockResolvedValue(positionFixture());
    renderJournalModal(positionFixture({ id: 7, accountId: 'CASH' }));

    fireEvent.change(screen.getByPlaceholderText(/INDIVIDUAL_CASH/), { target: { value: '' } });
    fireEvent.click(screen.getByText('Save'));

    await waitFor(() => expect(spy).toHaveBeenCalledWith(7, expect.objectContaining({ accountId: null })));
  });
});

describe('JournalEditModal — correcting the entry date', () => {
  // The integrity report tells you to fix a mis-dated position "via the
  // position's journal dialog" — advice that was unfollowable until this
  // field existed, because the dialog only ever edited tags/grade/notes/account.
  const dateInput = () => screen.getAllByDisplayValue(/^\d{4}-\d{2}-\d{2}$/)[0];

  it('pre-fills from the position and saves a correction', async () => {
    const spy = vi.spyOn(client, 'updatePosition').mockResolvedValue(positionFixture());
    renderJournalModal(positionFixture({ id: 7, entryDate: '2026-07-25' }));

    expect(dateInput()).toHaveValue('2026-07-25');
    fireEvent.change(dateInput(), { target: { value: '2026-07-20' } });
    fireEvent.click(screen.getByText('Save'));

    await waitFor(() => expect(spy).toHaveBeenCalledWith(7, expect.objectContaining({ entryDate: '2026-07-20' })));
  });

  it('sends null when cleared — "I do not know" is a real answer, not an empty box', async () => {
    const spy = vi.spyOn(client, 'updatePosition').mockResolvedValue(positionFixture());
    renderJournalModal(positionFixture({ id: 7, entryDate: '2026-07-25' }));

    fireEvent.change(dateInput(), { target: { value: '' } });
    fireEvent.click(screen.getByText('Save'));

    await waitFor(() => expect(spy).toHaveBeenCalledWith(7, expect.objectContaining({ entryDate: null })));
  });

  it('renders an undated position with an empty field rather than a guess', () => {
    renderJournalModal(positionFixture({ entryDate: null }));
    const inputs = screen.getAllByLabelText(/Entry date/i);
    expect(inputs[0]).toHaveValue('');
  });

  it("caps the picker at the position's own exit, which the server also refuses to cross", () => {
    renderJournalModal(
      positionFixture({
        entryDate: '2026-07-01',
        exits: [
          {
            id: 1,
            positionId: 7,
            quantity: 100,
            exitPrice: 110,
            exitDate: '2026-07-05',
            fees: 0,
            notes: null,
            sourceIntentId: null,
            createdAt: Date.now(),
          },
        ],
      }),
    );
    expect(screen.getAllByLabelText(/Entry date/i)[0]).toHaveAttribute('max', '2026-07-05');
  });
});

describe('JournalEditModal — removing a mistaken exit (2026-07-17, multi-account fix recovery path)', () => {
  const exitFixture = {
    id: 9,
    positionId: 7,
    quantity: 50,
    exitPrice: 10,
    exitDate: '2026-07-16',
    fees: 0,
    notes: 'Auto-closed via Webull sync — no longer held at the broker.',
    sourceIntentId: null,
    createdAt: Date.now(),
  };

  it('shows no exits section when the position has none', () => {
    renderJournalModal(positionFixture({ exits: [] }));
    expect(screen.queryByText('Exits')).toBeNull();
  });

  it('lists each exit with date, quantity, price, and notes', () => {
    renderJournalModal(positionFixture({ exits: [exitFixture] }));
    expect(screen.getByText('Exits')).toBeInTheDocument();
    expect(screen.getByText(/50 @ \$10\.00/)).toBeInTheDocument();
    expect(screen.getByText(/Auto-closed via Webull sync/)).toBeInTheDocument();
  });

  it('does nothing when the confirm dialog is cancelled', async () => {
    const del = vi.spyOn(client, 'deleteExit');
    renderJournalModal(positionFixture({ exits: [exitFixture] }));

    fireEvent.click(screen.getByText('remove'));
    expect(await screen.findByText('Remove this exit?')).toBeInTheDocument();
    // Two "Cancel" buttons are on screen at once: the confirm dialog's own,
    // and the still-open JournalEditModal's underneath it. The confirm
    // dialog renders last (ConfirmProvider puts it after {children} in the
    // tree, and Modal isn't portaled), so it's the last match.
    const cancelButtons = screen.getAllByText('Cancel');
    fireEvent.click(cancelButtons[cancelButtons.length - 1]);

    await waitFor(() => expect(screen.queryByText('Remove this exit?')).toBeNull());
    expect(del).not.toHaveBeenCalled();
  });

  it('deletes the exit and reloads once confirmed', async () => {
    const del = vi
      .spyOn(client, 'deleteExit')
      .mockResolvedValue({ deleted: 9, position: positionFixture({ exits: [] }) });
    const onSaved = vi.fn();
    renderJournalModal(positionFixture({ id: 7, exits: [exitFixture] }), onSaved);

    fireEvent.click(screen.getByText('remove'));
    await screen.findByText('Remove this exit?');
    fireEvent.click(screen.getByText('Remove exit'));

    await waitFor(() => expect(del).toHaveBeenCalledWith(7, 9));
    expect(onSaved).toHaveBeenCalled();
  });
});

// Both of these ran under a bare try/finally, so a rejected request was
// swallowed whole: the dialog just went un-busy with nothing said anywhere,
// which reads exactly like it worked.
describe('JournalEditModal — a failed request has to say so', () => {
  const exitFixture = {
    id: 9,
    positionId: 7,
    quantity: 50,
    exitPrice: 10,
    exitDate: '2026-07-16',
    fees: 0,
    notes: null,
    sourceIntentId: null,
    createdAt: Date.now(),
  };

  it('surfaces a failed save and keeps the dialog open with the edits intact', async () => {
    vi.spyOn(client, 'updatePosition').mockRejectedValue(new Error('quantity is below the 6 already exited'));
    const onSaved = vi.fn();
    renderJournalModal(positionFixture({ id: 7, accountId: 'CASH' }), onSaved);

    fireEvent.change(screen.getByPlaceholderText(/INDIVIDUAL_CASH/), { target: { value: 'MARGIN' } });
    fireEvent.click(screen.getByText('Save'));

    expect(await screen.findByText(/already exited/)).toBeInTheDocument();
    expect(onSaved).not.toHaveBeenCalled();
    expect(screen.getByPlaceholderText(/INDIVIDUAL_CASH/)).toHaveValue('MARGIN'); // not discarded
  });

  it('surfaces a failed exit removal instead of leaving the exit listed with no explanation', async () => {
    vi.spyOn(client, 'deleteExit').mockRejectedValue(new Error('exit not found on this position'));
    const onSaved = vi.fn();
    renderJournalModal(positionFixture({ id: 7, exits: [exitFixture] }), onSaved);

    fireEvent.click(screen.getByText('remove'));
    await screen.findByText('Remove this exit?');
    fireEvent.click(screen.getByText('Remove exit'));

    expect(await screen.findByText(/exit not found on this position/)).toBeInTheDocument();
    expect(onSaved).not.toHaveBeenCalled();
    // Still listed and still removable — pressing remove again is the obvious
    // next move, and it must not be stuck busy.
    expect(screen.getByText('remove')).toBeInTheDocument();
  });
});

describe('CloseModal — a close that did not go through still changed something', () => {
  const arm = async (pos: Position) => {
    const user = userEvent.setup();
    fireEvent.change(screen.getByPlaceholderText('e.g. 12345678'), { target: { value: 'ACC1' } });
    await user.type(
      screen.getByLabelText(/type to confirm/i),
      `SELL ${pos.remainingQuantity} ${pos.symbol.toUpperCase()}`,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Close position' }));
  };

  it('warns that the resting stop was cancelled and not re-placed when the close fails', async () => {
    // closeLivePosition cancels the bracket FIRST — it has to, or the close
    // could fill next to a working stop and sell twice. When the close then
    // fails, that cancel already happened and the position is open and
    // unprotected. "✕ Not placed" alone reads as "nothing changed".
    vi.spyOn(client, 'closePosition').mockResolvedValue({
      ok: true,
      placed: false,
      reason: 'blocked',
      error: 'daily loss cap reached',
      bracketCancelled: true,
    });
    const pos = positionFixture({ sourceIntentId: 42 });
    renderModal(pos);
    await arm(pos);

    expect(await screen.findByText(/no longer has that protection/i)).toBeInTheDocument();
  });

  it('does not cry wolf when there was no bracket to cancel', async () => {
    vi.spyOn(client, 'closePosition').mockResolvedValue({
      ok: true,
      placed: false,
      reason: 'blocked',
      error: 'daily loss cap reached',
    });
    const pos = positionFixture();
    renderModal(pos);
    await arm(pos);

    expect(await screen.findByText(/Not placed/)).toBeInTheDocument();
    expect(screen.queryByText(/no longer has that protection/i)).toBeNull();
  });

  it('refreshes the page on an UNKNOWN outcome — the order may be working', async () => {
    vi.spyOn(client, 'closePosition').mockResolvedValue({
      ok: true,
      placed: false,
      reason: 'outcome_unknown',
      error: 'the broker did not respond',
    });
    const onSaved = vi.fn();
    const pos = positionFixture();
    renderModal(pos, onSaved);
    await arm(pos);

    expect(await screen.findByText(/Outcome unknown/)).toBeInTheDocument();
    // Gated behind `placed`, this left the page showing the position exactly
    // as it was — reading as "nothing happened" on the one outcome where
    // re-reading the truth matters most.
    await waitFor(() => expect(onSaved).toHaveBeenCalled());
  });
});

describe('ExitModal — exit date cannot predate the entry', () => {
  it('floors the date picker at the entry date the server would reject going below', () => {
    render(
      <ToastProvider>
        <ExitModal position={positionFixture({ entryDate: '2026-07-01' })} onClose={vi.fn()} onSaved={vi.fn()} />
      </ToastProvider>,
    );
    const dateInputs = screen.getAllByDisplayValue(/^\d{4}-\d{2}-\d{2}$/);
    expect(dateInputs.some((el) => el.getAttribute('min') === '2026-07-01')).toBe(true);
  });
});
