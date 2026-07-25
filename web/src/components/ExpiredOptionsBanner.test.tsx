import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ExpiredOptionsBanner } from './ExpiredOptionsBanner';
import { ToastProvider } from './ToastContext';
import { client } from '../api/client';
import type { ExpiredOptionFinding, ExpiredOptionsSweepResult } from '../api/types';

// An option held through expiry never produces a closing order, so nothing ever
// records an exit and the position sits open forever — inflating exposure, the
// risk caps and the P&L tiles. This banner is how that becomes visible, and the
// close is a deliberate press rather than a background write, since $0 exits
// change realized P&L in the journal and the tax export.

const finding = (over: Partial<ExpiredOptionFinding> = {}): ExpiredOptionFinding => ({
  positionId: 1,
  symbol: 'AAPL',
  label: 'AAPL 200C 2026-07-17',
  expiration: '2026-07-17',
  side: 'long',
  remainingQuantity: 2,
  disposition: 'worthless',
  underlyingAtExpiry: 150,
  intrinsic: 0,
  reason: 'AAPL closed at 150 against a 200 strike — expired worthless',
  ...over,
});

const result = (over: Partial<ExpiredOptionsSweepResult> = {}): ExpiredOptionsSweepResult => ({
  examined: 0,
  closed: [],
  needsReview: [],
  ...over,
});

function renderBanner(onChanged = vi.fn()) {
  return render(
    <ToastProvider>
      <ExpiredOptionsBanner onChanged={onChanged} />
    </ToastProvider>,
  );
}

beforeEach(() => vi.restoreAllMocks());

describe('ExpiredOptionsBanner', () => {
  it('renders nothing when there is nothing expired', async () => {
    vi.spyOn(client, 'expiredOptions').mockResolvedValue(result());
    const { container } = renderBanner();
    await waitFor(() => expect(client.expiredOptions).toHaveBeenCalled());
    expect(container.textContent).toBe('');
  });

  it('lists worthless positions with a close action', async () => {
    vi.spyOn(client, 'expiredOptions').mockResolvedValue(result({ examined: 1, closed: [finding()] }));
    renderBanner();

    expect(await screen.findByText(/AAPL 200C 2026-07-17/)).toBeTruthy();
    expect(screen.getByText(/expired worthless/)).toBeTruthy();
    expect(screen.getByRole('button', { name: /close 1 at \$0/i })).toBeTruthy();
  });

  it('offers NO close action when everything needs review', async () => {
    // An in-the-money option was exercised or assigned into a stock position
    // the app doesn't model — it must never be closed by this flow.
    vi.spyOn(client, 'expiredOptions').mockResolvedValue(
      result({
        examined: 1,
        needsReview: [finding({ disposition: 'in_the_money', reason: 'closed at 250, 50.00/share in the money' })],
      }),
    );
    renderBanner();

    // The reason renders in its own node; the surrounding copy is split by <b>.
    expect(await screen.findByText(/50\.00\/share in the money/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: /close .* at \$0/i })).toBeNull();
  });

  it('shows both groups at once and only offers to close the worthless ones', async () => {
    vi.spyOn(client, 'expiredOptions').mockResolvedValue(
      result({
        examined: 2,
        closed: [finding()],
        needsReview: [
          finding({ positionId: 2, symbol: 'MSFT', label: 'MSFT 100C 2026-07-17', disposition: 'unknown' }),
        ],
      }),
    );
    renderBanner();

    expect(await screen.findByText(/2 option positions expired but still showing as open/i)).toBeTruthy();
    expect(screen.getByRole('button', { name: /close 1 at \$0/i })).toBeTruthy();
  });

  it('sweeps and tells the parent to refresh', async () => {
    vi.spyOn(client, 'expiredOptions').mockResolvedValue(result({ examined: 1, closed: [finding()] }));
    const sweep = vi
      .spyOn(client, 'sweepExpiredOptions')
      .mockResolvedValue(result({ examined: 1, closed: [finding()] }));
    const onChanged = vi.fn();
    renderBanner(onChanged);

    await userEvent.click(await screen.findByRole('button', { name: /close 1 at \$0/i }));

    await waitFor(() => expect(sweep).toHaveBeenCalled());
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
    expect(await screen.findByText(/Closed 1 expired position at \$0/i)).toBeTruthy();
  });

  it('surfaces a sweep failure instead of claiming success', async () => {
    vi.spyOn(client, 'expiredOptions').mockResolvedValue(result({ examined: 1, closed: [finding()] }));
    vi.spyOn(client, 'sweepExpiredOptions').mockRejectedValue(new Error('database is locked'));
    const onChanged = vi.fn();
    renderBanner(onChanged);

    await userEvent.click(await screen.findByRole('button', { name: /close 1 at \$0/i }));

    expect(await screen.findByText(/database is locked/)).toBeTruthy();
    expect(onChanged).not.toHaveBeenCalled();
  });
});
