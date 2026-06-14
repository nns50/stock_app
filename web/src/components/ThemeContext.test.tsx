import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { ThemeProvider, useTheme } from './ThemeContext';

function Probe() {
  const { theme, toggle } = useTheme();
  return <button onClick={toggle}>theme:{theme}</button>;
}

function renderProbe() {
  render(
    <ThemeProvider>
      <Probe />
    </ThemeProvider>,
  );
}

beforeEach(() => {
  localStorage.clear();
  document.documentElement.removeAttribute('data-theme');
});

describe('ThemeContext', () => {
  it('defaults to dark and reflects it on <html>', () => {
    renderProbe();
    expect(screen.getByText('theme:dark')).toBeInTheDocument();
    expect(document.documentElement.dataset.theme).toBe('dark');
  });

  it('toggles to light, updates <html>, and persists', () => {
    renderProbe();
    fireEvent.click(screen.getByRole('button'));
    expect(screen.getByText('theme:light')).toBeInTheDocument();
    expect(document.documentElement.dataset.theme).toBe('light');
    expect(localStorage.getItem('app.theme')).toBe('light');
  });

  it('restores a previously saved theme', () => {
    localStorage.setItem('app.theme', 'light');
    renderProbe();
    expect(screen.getByText('theme:light')).toBeInTheDocument();
  });
});
