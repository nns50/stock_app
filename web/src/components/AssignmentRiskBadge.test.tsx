import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { AssignmentRiskBadge, intrinsicValue, extrinsicValue, LOW_EXTRINSIC_THRESHOLD } from './AssignmentRiskBadge';
import type { SymbolEvents } from '../api/types';

describe('intrinsicValue', () => {
  it('a call is worth underlying minus strike, floored at 0', () => {
    expect(intrinsicValue('call', 100, 110)).toBe(10);
    expect(intrinsicValue('call', 100, 90)).toBe(0);
  });

  it('a put is worth strike minus underlying, floored at 0', () => {
    expect(intrinsicValue('put', 100, 90)).toBe(10);
    expect(intrinsicValue('put', 100, 110)).toBe(0);
  });

  it('is null when the underlying price is unavailable, never a fabricated 0', () => {
    expect(intrinsicValue('call', 100, null)).toBeNull();
  });
});

describe('extrinsicValue', () => {
  it('is mark minus intrinsic', () => {
    expect(extrinsicValue('call', 100, 12, 110)).toBe(2); // 12 mark - 10 intrinsic
  });

  it('floors at 0 when a stale/wide mark prints below intrinsic', () => {
    expect(extrinsicValue('call', 100, 9, 110)).toBe(0); // 9 mark - 10 intrinsic would be -1
  });

  it('is null when the mark is unavailable', () => {
    expect(extrinsicValue('call', 100, null, 110)).toBeNull();
  });

  it('is null when the underlying price is unavailable', () => {
    expect(extrinsicValue('call', 100, 12, null)).toBeNull();
  });
});

const NOW = '2026-07-23T12:00:00Z';
function inDays(n: number): string {
  const d = new Date(Date.parse(NOW) + n * 86_400_000);
  return d.toISOString().slice(0, 10);
}
const eventsWithExDiv = (exDividendDate?: string): SymbolEvents => ({ symbol: 'AAPL', exDividendDate });

describe('AssignmentRiskBadge', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(NOW));
  });
  afterEach(() => vi.useRealTimers());

  it('renders nothing when the leg is out-of-the-money', () => {
    const { container } = render(<AssignmentRiskBadge side="call" strike={100} mark={1} underlyingPrice={90} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('renders nothing when the leg still has real time value left', () => {
    const { container } = render(
      // 15 intrinsic, mark 15.50 -> 0.50 extrinsic, above the 0.05 threshold
      <AssignmentRiskBadge side="call" strike={100} mark={15.5} underlyingPrice={115} />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it('renders nothing when a needed price is unavailable', () => {
    const { container } = render(<AssignmentRiskBadge side="call" strike={100} mark={null} underlyingPrice={115} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('shows the general assignment-risk badge for a deep-ITM, near-zero-extrinsic short PUT', () => {
    render(<AssignmentRiskBadge side="put" strike={100} mark={20} underlyingPrice={80} />);
    expect(screen.getByText('Assignment risk')).toBeInTheDocument();
  });

  it('shows the general (not dividend) badge for a deep-ITM short CALL with no ex-dividend date known', () => {
    render(<AssignmentRiskBadge side="call" strike={100} mark={15.02} underlyingPrice={115} />);
    expect(screen.getByText('Assignment risk')).toBeInTheDocument();
  });

  it('shows the general (not dividend) badge when ex-dividend is well outside the risk window', () => {
    render(
      <AssignmentRiskBadge
        side="call"
        strike={100}
        mark={15.02}
        underlyingPrice={115}
        events={eventsWithExDiv(inDays(30))}
      />,
    );
    expect(screen.getByText('Assignment risk')).toBeInTheDocument();
  });

  it('shows the general (not dividend) badge when the ex-dividend date has already passed', () => {
    render(
      <AssignmentRiskBadge
        side="call"
        strike={100}
        mark={15.02}
        underlyingPrice={115}
        events={eventsWithExDiv(inDays(-1))}
      />,
    );
    expect(screen.getByText('Assignment risk')).toBeInTheDocument();
  });

  it('shows the dividend-specific badge for a deep-ITM short CALL with an imminent ex-dividend date', () => {
    render(
      <AssignmentRiskBadge
        side="call"
        strike={100}
        mark={15.02}
        underlyingPrice={115}
        events={eventsWithExDiv(inDays(2))}
      />,
    );
    expect(screen.getByText('Div. assignment risk')).toBeInTheDocument();
    expect(screen.queryByText('Assignment risk')).toBeNull();
  });

  it('never shows the dividend flavor for a PUT, even with an imminent ex-dividend date — early exercise there is rate-driven, not dividend-driven', () => {
    render(
      <AssignmentRiskBadge
        side="put"
        strike={100}
        mark={20.02}
        underlyingPrice={80}
        events={eventsWithExDiv(inDays(2))}
      />,
    );
    expect(screen.getByText('Assignment risk')).toBeInTheDocument();
    expect(screen.queryByText('Div. assignment risk')).toBeNull();
  });

  it('the low-extrinsic threshold constant is exported for callers/tests that need the exact cutoff', () => {
    expect(LOW_EXTRINSIC_THRESHOLD).toBe(0.05);
  });
});
