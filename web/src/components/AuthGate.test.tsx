import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { AuthGate } from './AuthGate';
import { client } from '../api/client';

beforeEach(() => {
  vi.restoreAllMocks();
});

describe('AuthGate', () => {
  it('passes through to the app when auth is not required', async () => {
    vi.spyOn(client, 'authStatus').mockResolvedValue({ required: false, authenticated: true } as never);
    render(
      <AuthGate>
        <div>protected content</div>
      </AuthGate>,
    );
    expect(await screen.findByText('protected content')).toBeInTheDocument();
  });

  it('shows the login screen when required and not yet authenticated', async () => {
    vi.spyOn(client, 'authStatus').mockResolvedValue({ required: true, authenticated: false } as never);
    render(
      <AuthGate>
        <div>protected content</div>
      </AuthGate>,
    );
    expect(await screen.findByRole('heading', { name: 'Sign in' })).toBeInTheDocument();
    expect(screen.queryByText('protected content')).toBeNull();
  });

  it('logs in and reveals the app on a correct password', async () => {
    vi.spyOn(client, 'authStatus').mockResolvedValue({ required: true, authenticated: false } as never);
    const login = vi.spyOn(client, 'login').mockResolvedValue({ ok: true } as never);
    render(
      <AuthGate>
        <div>protected content</div>
      </AuthGate>,
    );
    await screen.findByRole('heading', { name: 'Sign in' });
    fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'hunter2' } });
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));
    await waitFor(() => expect(login).toHaveBeenCalledWith('hunter2'));
    expect(await screen.findByText('protected content')).toBeInTheDocument();
  });
});
