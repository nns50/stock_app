import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { SectorRotationPanel } from './SectorRotationPanel';
import { client } from '../api/client';
import type { SectorRotation } from '../api/types';

beforeEach(() => {
  localStorage.clear();
  vi.restoreAllMocks();
});

function fixture(overrides: Partial<SectorRotation> = {}): SectorRotation {
  return {
    benchmarkSymbol: 'SPY',
    benchmarkReturnPct: 2,
    basis: 'relative-to-benchmark',
    lookbackDays: 20,
    sectors: [
      {
        sector: 'Information Technology',
        medianRelStrengthPct: 8.4,
        memberCount: 12,
        sampledCount: 12,
        members: ['AAPL', 'MSFT', 'NVDA'],
        topSymbol: { symbol: 'NVDA', relStrengthPct: 21.3 },
      },
      {
        sector: 'Utilities',
        medianRelStrengthPct: -3.1,
        memberCount: 6,
        sampledCount: 6,
        members: ['NEE', 'DUK'],
        topSymbol: { symbol: 'NEE', relStrengthPct: 0.4 },
      },
    ],
    unresolvedSectors: [],
    asOf: 1_700_000_000_000,
    ...overrides,
  };
}

function expand() {
  fireEvent.click(screen.getByRole('button', { name: 'Sector rotation' }));
}

describe('SectorRotationPanel', () => {
  it('fetches nothing while collapsed (its default state)', () => {
    const spy = vi.spyOn(client, 'sectorRotation');
    render(<SectorRotationPanel onPickSector={() => {}} />);
    expect(spy).not.toHaveBeenCalled();
  });

  it('ranks sectors with their median relative strength once expanded', async () => {
    vi.spyOn(client, 'sectorRotation').mockResolvedValue(fixture());
    render(<SectorRotationPanel onPickSector={() => {}} />);
    expand();
    expect(await screen.findByText('Information Technology')).toBeInTheDocument();
    expect(screen.getByText('+8.4%')).toBeInTheDocument();
    expect(screen.getByText('-3.1%')).toBeInTheDocument();
  });

  it('hands a sector’s members to onPickSector when clicked', async () => {
    const onPick = vi.fn();
    vi.spyOn(client, 'sectorRotation').mockResolvedValue(fixture());
    render(<SectorRotationPanel onPickSector={onPick} />);
    expand();
    // The row is a button whose accessible name includes the sector.
    fireEvent.click(await screen.findByRole('button', { name: /Information Technology/ }));
    expect(onPick).toHaveBeenCalledWith('Information Technology', ['AAPL', 'MSFT', 'NVDA']);
  });

  it('explains the absolute-return fallback when the benchmark is unavailable', async () => {
    vi.spyOn(client, 'sectorRotation').mockResolvedValue(
      fixture({ basis: 'absolute-return', benchmarkReturnPct: null }),
    );
    render(<SectorRotationPanel onPickSector={() => {}} />);
    expand();
    expect(await screen.findByText(/falls back to plain momentum/)).toBeInTheDocument();
  });

  it('lists sectors with no fetchable history', async () => {
    vi.spyOn(client, 'sectorRotation').mockResolvedValue(fixture({ unresolvedSectors: ['Energy', 'Materials'] }));
    render(<SectorRotationPanel onPickSector={() => {}} />);
    expand();
    expect(await screen.findByText(/No fetchable history: Energy, Materials/)).toBeInTheDocument();
  });

  it('shows an error state with a retry that re-fetches', async () => {
    const spy = vi
      .spyOn(client, 'sectorRotation')
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValueOnce(fixture());
    render(<SectorRotationPanel onPickSector={() => {}} />);
    expand();
    expect(await screen.findByText(/boom/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /retry/i }));
    expect(await screen.findByText('Information Technology')).toBeInTheDocument();
    expect(spy).toHaveBeenCalledTimes(2);
  });
});
