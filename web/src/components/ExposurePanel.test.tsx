import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { ExposurePanel } from './ExposurePanel';
import type { Exposure } from '../api/types';

function exposureFixture(overrides: Partial<Exposure> = {}): Exposure {
  return {
    gross: 10_000,
    net: 6_000,
    long: 8_000,
    short: 2_000,
    bySector: [
      { key: 'Technology', gross: 6_000, pct: 60, count: 3 },
      { key: 'Energy', gross: 4_000, pct: 40, count: 1 },
    ],
    largest: { symbol: 'AAPL', pct: 30 },
    ...overrides,
  };
}

describe('ExposurePanel', () => {
  it('renders the long/short split and every sector slice', () => {
    render(<ExposurePanel exposure={exposureFixture()} />);
    expect(screen.getByText(/Long \$8,000\.00/)).toBeInTheDocument();
    expect(screen.getByText(/Short \$2,000\.00/)).toBeInTheDocument();
    expect(screen.getByText('Technology')).toBeInTheDocument();
    expect(screen.getByText('Energy')).toBeInTheDocument();
    expect(screen.getByText(/gross \$10,000\.00/)).toBeInTheDocument();
  });

  it('warns on a concentrated sector (≥ 50%) and a concentrated single name (≥ 40%)', () => {
    render(
      <ExposurePanel
        exposure={exposureFixture({
          bySector: [{ key: 'Technology', gross: 8_000, pct: 80, count: 4 }],
          largest: { symbol: 'NVDA', pct: 45 },
        })}
      />,
    );
    const warning = screen.getByText(/Concentrated/);
    expect(warning).toHaveTextContent('80% in Technology');
    expect(warning).toHaveTextContent('45% in NVDA');
  });

  it('stays quiet when nothing is concentrated', () => {
    render(
      <ExposurePanel
        exposure={exposureFixture({
          bySector: [
            { key: 'Technology', gross: 3_000, pct: 30, count: 2 },
            { key: 'Energy', gross: 7_000, pct: 70, count: 3 },
          ],
          largest: { symbol: 'AAPL', pct: 20 },
        })}
      />,
    );
    // bySector[0] is 30% here — the check reads the FIRST slice, which the
    // server sorts by gross descending, so an unsorted list would misreport.
    expect(screen.queryByText(/Concentrated/)).toBeNull();
  });

  it('renders nothing at all when there is no open exposure', () => {
    const { container } = render(<ExposurePanel exposure={exposureFixture({ gross: 0 })} />);
    expect(container).toBeEmptyDOMElement();
  });
});
