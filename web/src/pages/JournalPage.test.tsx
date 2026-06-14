import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import JournalPage from './JournalPage';
import { client } from '../api/client';

beforeEach(() => vi.restoreAllMocks());

describe('JournalPage', () => {
  it('mounts and shows its loading state without crashing', () => {
    vi.spyOn(client, 'journalStats').mockReturnValue(new Promise(() => {}) as never);
    vi.spyOn(client, 'positionsWithPnl').mockReturnValue(new Promise(() => {}) as never);
    render(
      <MemoryRouter>
        <JournalPage />
      </MemoryRouter>,
    );
    expect(screen.getByText(/Loading journal/)).toBeInTheDocument();
  });
});
