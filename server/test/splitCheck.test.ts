import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../src/services/splits', () => ({ getRecentSplits: vi.fn() }));
vi.mock('../src/db/autotradePaperPositions', () => ({ listOpenPaperPositions: vi.fn() }));
vi.mock('../src/db/autotradeOptionsPaperPositions', () => ({ listOpenOptionsPaperPositions: vi.fn() }));
vi.mock('../src/db/autotradeLiveOptionsPositions', () => ({ listOpenLiveOptionsPositions: vi.fn() }));
vi.mock('../src/services/autotrading/liveExecute', () => ({ listAutotradeLivePositions: vi.fn() }));
vi.mock('../src/db/autotradeEvents', () => ({ logAutotradeEvent: vi.fn() }));
vi.mock('../src/services/notifier', () => ({ dispatchNotifications: vi.fn() }));

import { getRecentSplits } from '../src/services/splits';
import { listOpenPaperPositions } from '../src/db/autotradePaperPositions';
import { listOpenOptionsPaperPositions } from '../src/db/autotradeOptionsPaperPositions';
import { listOpenLiveOptionsPositions } from '../src/db/autotradeLiveOptionsPositions';
import { listAutotradeLivePositions } from '../src/services/autotrading/liveExecute';
import { logAutotradeEvent } from '../src/db/autotradeEvents';
import { dispatchNotifications } from '../src/services/notifier';
import { checkForRecentSplits, resetSplitCheckState } from '../src/services/autotrading/splitCheck';

const mockGetRecentSplits = vi.mocked(getRecentSplits);
const mockPaper = vi.mocked(listOpenPaperPositions);
const mockOptionsPaper = vi.mocked(listOpenOptionsPaperPositions);
const mockLiveOptions = vi.mocked(listOpenLiveOptionsPositions);
const mockLive = vi.mocked(listAutotradeLivePositions);
const mockLogEvent = vi.mocked(logAutotradeEvent);
const mockNotify = vi.mocked(dispatchNotifications);

beforeEach(() => {
  resetSplitCheckState();
  mockGetRecentSplits.mockReset().mockResolvedValue(new Map());
  mockPaper.mockReset().mockReturnValue([]);
  mockOptionsPaper.mockReset().mockReturnValue([]);
  mockLiveOptions.mockReset().mockReturnValue([]);
  mockLive.mockReset().mockReturnValue([]);
  mockLogEvent.mockReset();
  mockNotify.mockReset().mockResolvedValue({ delivered: false, count: 0, results: [] });
});

describe('checkForRecentSplits', () => {
  it('is a no-op (no lookup) when nothing is open', async () => {
    await checkForRecentSplits();
    expect(mockGetRecentSplits).not.toHaveBeenCalled();
  });

  it('gathers symbols from all four open-position sources (paper/live, equity/options)', async () => {
    mockPaper.mockReturnValue([{ symbol: 'AAPL' }] as never);
    mockOptionsPaper.mockReturnValue([{ symbol: 'MSFT' }] as never);
    mockLive.mockReturnValue([{ symbol: 'TSLA' }] as never);
    mockLiveOptions.mockReturnValue([{ symbol: 'NVDA' }] as never);
    await checkForRecentSplits();
    const [symbols] = mockGetRecentSplits.mock.calls[0];
    expect(new Set(symbols)).toEqual(new Set(['AAPL', 'MSFT', 'TSLA', 'NVDA']));
  });

  it('journals and notifies when a split is found', async () => {
    mockPaper.mockReturnValue([{ symbol: 'AAPL' }] as never);
    mockGetRecentSplits.mockResolvedValue(
      new Map([['AAPL', [{ date: '2026-07-05', splitRatio: '4:1', numerator: 4, denominator: 1 }]]]),
    );
    await checkForRecentSplits();

    expect(mockLogEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        symbol: 'AAPL',
        action: 'split_detected',
        detail: { date: '2026-07-05', splitRatio: '4:1' },
      }),
    );
    expect(mockNotify).toHaveBeenCalledWith([expect.objectContaining({ title: 'AAPL' })]);
  });

  it('does not journal or notify when no split is found', async () => {
    mockPaper.mockReturnValue([{ symbol: 'AAPL' }] as never);
    mockGetRecentSplits.mockResolvedValue(new Map([['AAPL', []]]));
    await checkForRecentSplits();
    expect(mockLogEvent).not.toHaveBeenCalled();
    expect(mockNotify).not.toHaveBeenCalled();
  });

  it('only looks up once per ET calendar day', async () => {
    mockPaper.mockReturnValue([{ symbol: 'AAPL' }] as never);
    await checkForRecentSplits();
    expect(mockGetRecentSplits).toHaveBeenCalledTimes(1);
    await checkForRecentSplits(); // same day -> no-op
    expect(mockGetRecentSplits).toHaveBeenCalledTimes(1);
  });
});
