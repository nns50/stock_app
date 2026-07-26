import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import {
  Badge,
  CollapsibleCard,
  EmptyState,
  InfoTip,
  PnL,
  ScoreBar,
  Segmented,
  SkeletonStats,
  SkeletonTable,
  SortTh,
  StatTile,
} from './ui';

beforeEach(() => {
  localStorage.clear();
});

describe('ScoreBar', () => {
  it('renders the numeric score label', () => {
    render(<ScoreBar value={72.4} />);
    expect(screen.getByText('72.4')).toBeInTheDocument();
  });
  it('clamps out-of-range values to the 0..100 label', () => {
    render(<ScoreBar value={140} />);
    expect(screen.getByText('100.0')).toBeInTheDocument();
  });
});

describe('Badge', () => {
  it('renders children with the color class', () => {
    render(<Badge color="green">live</Badge>);
    const el = screen.getByText('live');
    expect(el).toBeInTheDocument();
    expect(el.className).toContain('text-bull');
  });
});

describe('StatTile', () => {
  it('shows label, value and sub', () => {
    render(<StatTile label="Win rate" value="66%" sub="2W · 1L" />);
    expect(screen.getByText('Win rate')).toBeInTheDocument();
    expect(screen.getByText('66%')).toBeInTheDocument();
    expect(screen.getByText('2W · 1L')).toBeInTheDocument();
  });
  it('renders an info affordance when given info text', () => {
    render(<StatTile label="Expectancy" value="$5" info="Average P&L per trade." />);
    expect(screen.getByLabelText('About Expectancy')).toBeInTheDocument();
  });
});

describe('PnL', () => {
  it('shows an up caret + bull color for gains', () => {
    render(<PnL value={12.5} />);
    const el = screen.getByText(/\+\$12\.50/);
    expect(el.className).toContain('text-bull');
    expect(el.textContent).toContain('▲');
  });
  it('shows a down caret + bear color for losses', () => {
    render(<PnL value={-8} />);
    const el = screen.getByText(/-\$8\.00/);
    expect(el.className).toContain('text-bear');
    expect(el.textContent).toContain('▼');
  });
  it('is neutral (no caret) at zero', () => {
    render(<PnL value={0} />);
    const el = screen.getByText('+$0.00');
    expect(el.textContent).not.toContain('▲');
    expect(el.textContent).not.toContain('▼');
  });
});

describe('InfoTip', () => {
  it('exposes its text via an accessible label and tooltip', () => {
    render(<InfoTip text="Gross profit ÷ gross loss." />);
    expect(screen.getByRole('button', { name: 'Gross profit ÷ gross loss.' })).toBeInTheDocument();
    expect(screen.getByRole('tooltip')).toHaveTextContent('Gross profit ÷ gross loss.');
  });
});

describe('EmptyState', () => {
  it('renders title and hint', () => {
    render(<EmptyState title="Nothing here" hint="Add some data" />);
    expect(screen.getByText('Nothing here')).toBeInTheDocument();
    expect(screen.getByText('Add some data')).toBeInTheDocument();
  });
});

describe('Segmented', () => {
  it('marks the active option and fires onChange when another is picked', () => {
    const onChange = vi.fn();
    render(
      <Segmented
        value="a"
        onChange={onChange}
        options={[
          { value: 'a', label: 'Alpha' },
          { value: 'b', label: 'Beta' },
        ]}
      />,
    );
    expect(screen.getByRole('tab', { name: 'Alpha' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('tab', { name: 'Beta' })).toHaveAttribute('aria-selected', 'false');
    fireEvent.click(screen.getByRole('tab', { name: 'Beta' }));
    expect(onChange).toHaveBeenCalledWith('b');
  });
});

describe('CollapsibleCard', () => {
  it('shows children and the action slot by default', () => {
    render(
      <CollapsibleCard id="test.tile" title="Watchlist" action={<button>Manage</button>}>
        <div>tile body</div>
      </CollapsibleCard>,
    );
    expect(screen.getByText('tile body')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Manage' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Watchlist' })).toHaveAttribute('aria-expanded', 'true');
  });

  it('hides children and the action slot when the header is clicked, and toggles back', () => {
    render(
      <CollapsibleCard id="test.tile" title="Watchlist" action={<button>Manage</button>}>
        <div>tile body</div>
      </CollapsibleCard>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Watchlist' }));
    expect(screen.queryByText('tile body')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Manage' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Watchlist' })).toHaveAttribute('aria-expanded', 'false');

    fireEvent.click(screen.getByRole('button', { name: 'Watchlist' }));
    expect(screen.getByText('tile body')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Watchlist' })).toHaveAttribute('aria-expanded', 'true');
  });

  it('persists collapsed state across remounts under its id', () => {
    const { unmount } = render(
      <CollapsibleCard id="test.persisted" title="Movers">
        <div>tile body</div>
      </CollapsibleCard>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Movers' }));
    expect(screen.queryByText('tile body')).toBeNull();
    unmount();

    render(
      <CollapsibleCard id="test.persisted" title="Movers">
        <div>tile body</div>
      </CollapsibleCard>,
    );
    expect(screen.queryByText('tile body')).toBeNull();
    expect(screen.getByRole('button', { name: 'Movers' })).toHaveAttribute('aria-expanded', 'false');
  });

  it('keeps separate tiles independent by id', () => {
    render(
      <>
        <CollapsibleCard id="test.a" title="Tile A">
          <div>body A</div>
        </CollapsibleCard>
        <CollapsibleCard id="test.b" title="Tile B">
          <div>body B</div>
        </CollapsibleCard>
      </>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Tile A' }));
    expect(screen.queryByText('body A')).toBeNull();
    expect(screen.getByText('body B')).toBeInTheDocument();
  });
});

describe('skeletons', () => {
  it('SkeletonTable exposes an accessible loading status with the requested rows', () => {
    const { container } = render(<SkeletonTable rows={4} cols={3} />);
    expect(screen.getByRole('status', { name: 'Loading' })).toBeInTheDocument();
    expect(container.querySelectorAll('.skeleton').length).toBe(4 * 3);
  });
  it('SkeletonStats renders the requested number of tiles', () => {
    const { container } = render(<SkeletonStats count={6} />);
    // Two shimmer blocks per tile (label + value).
    expect(container.querySelectorAll('.skeleton').length).toBe(12);
  });
});

describe('SortTh', () => {
  // Sorting used to be a click handler on the <th>: unreachable by keyboard,
  // and a screen reader saw a plain column label with no hint it did anything
  // or which way the table was currently ordered.
  const renderTh = (props: Partial<Parameters<typeof SortTh>[0]> = {}) => {
    const onSort = vi.fn();
    render(
      <table>
        <thead>
          <tr>
            <SortTh label="Total P&L" k="total" active="total" dir="desc" onSort={onSort} {...props} />
          </tr>
        </thead>
      </table>,
    );
    return onSort;
  };

  it('exposes the sort control as a real button, so it is focusable and keyboard-operable', () => {
    const onSort = renderTh();
    const button = screen.getByRole('button', { name: /Total P&L/ });
    button.focus();
    expect(button).toHaveFocus();
    fireEvent.keyDown(button, { key: 'Enter' });
    fireEvent.click(button); // what Enter/Space dispatch on a real button
    expect(onSort).toHaveBeenCalledWith('total');
  });

  it('announces the current sort direction via aria-sort, and none on inactive columns', () => {
    renderTh();
    expect(screen.getByRole('columnheader')).toHaveAttribute('aria-sort', 'descending');

    cleanup();
    renderTh({ dir: 'asc' });
    expect(screen.getByRole('columnheader')).toHaveAttribute('aria-sort', 'ascending');

    cleanup();
    renderTh({ active: 'somethingElse' });
    expect(screen.getByRole('columnheader')).toHaveAttribute('aria-sort', 'none');
  });

  it('fires the sort exactly once per click (the handler moved off the th, so it cannot double-toggle)', () => {
    const onSort = renderTh();
    fireEvent.click(screen.getByRole('button', { name: /Total P&L/ }));
    expect(onSort).toHaveBeenCalledTimes(1);
  });
});
