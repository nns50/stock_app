import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { Badge, EmptyState, ScoreBar, StatTile } from './ui';

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
});

describe('EmptyState', () => {
  it('renders title and hint', () => {
    render(<EmptyState title="Nothing here" hint="Add some data" />);
    expect(screen.getByText('Nothing here')).toBeInTheDocument();
    expect(screen.getByText('Add some data')).toBeInTheDocument();
  });
});
