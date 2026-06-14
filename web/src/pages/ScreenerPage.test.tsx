import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import ScreenerPage from './ScreenerPage';
import { client } from '../api/client';

beforeEach(() => {
  vi.restoreAllMocks();
  // Pending promises keep the page in its initial loading state — enough to
  // prove it mounts and renders without throwing.
  const pending = () => new Promise(() => {}) as never;
  vi.spyOn(client, 'screenerDefault').mockImplementation(pending);
  vi.spyOn(client, 'settings').mockImplementation(pending);
  vi.spyOn(client, 'presets').mockImplementation(pending);
  vi.spyOn(client, 'universe').mockImplementation(pending);
});

describe('ScreenerPage', () => {
  it('mounts and shows its loading state without crashing', () => {
    render(
      <MemoryRouter>
        <ScreenerPage />
      </MemoryRouter>,
    );
    expect(screen.getByText(/Loading screener/)).toBeInTheDocument();
  });
});
