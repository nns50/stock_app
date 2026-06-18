import { describe, it, expect } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { KeyboardShortcuts } from './KeyboardShortcuts';

function LocationProbe() {
  return <div data-testid="loc">{useLocation().pathname}</div>;
}

function setup(initial = '/today') {
  render(
    <MemoryRouter initialEntries={[initial]}>
      <KeyboardShortcuts />
      <LocationProbe />
      <input data-testid="field" />
    </MemoryRouter>,
  );
}

describe('KeyboardShortcuts', () => {
  it('opens the cheat sheet on "?"', () => {
    setup();
    fireEvent.keyDown(window, { key: '?' });
    expect(screen.getByText('Keyboard shortcuts')).toBeInTheDocument();
  });

  it('navigates with the g-then-key chord', () => {
    setup('/today');
    fireEvent.keyDown(window, { key: 'g' });
    fireEvent.keyDown(window, { key: 'p' });
    expect(screen.getByTestId('loc')).toHaveTextContent('/positions');
  });

  it('does not hijack keys while typing in a field', () => {
    setup('/today');
    const field = screen.getByTestId('field');
    fireEvent.keyDown(field, { key: 'g' });
    fireEvent.keyDown(field, { key: 'p' });
    expect(screen.getByTestId('loc')).toHaveTextContent('/today');
    fireEvent.keyDown(field, { key: '?' });
    expect(screen.queryByText('Keyboard shortcuts')).toBeNull();
  });
});
