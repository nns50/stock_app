import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { RefreshBar } from './RefreshBar';

const intervalSelect = () => screen.getByTitle(/Optional polling interval/) as HTMLSelectElement;

describe('RefreshBar', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('defaults the auto-refresh interval to 1 minute, not off', () => {
    render(<RefreshBar onRefresh={() => {}} lastUpdated={null} />);
    expect(intervalSelect()).toHaveValue('60000');
  });

  it('polls onRefresh every minute by default', () => {
    const onRefresh = vi.fn();
    render(<RefreshBar onRefresh={onRefresh} lastUpdated={null} />);
    vi.advanceTimersByTime(60_000);
    expect(onRefresh).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(60_000);
    expect(onRefresh).toHaveBeenCalledTimes(2);
  });

  it('stops polling once switched to Off', () => {
    const onRefresh = vi.fn();
    render(<RefreshBar onRefresh={onRefresh} lastUpdated={null} />);
    fireEvent.change(intervalSelect(), { target: { value: 'off' } });
    vi.advanceTimersByTime(120_000);
    expect(onRefresh).not.toHaveBeenCalled();
  });

  it('the manual Refresh button calls onRefresh immediately', () => {
    const onRefresh = vi.fn();
    render(<RefreshBar onRefresh={onRefresh} lastUpdated={null} />);
    fireEvent.click(screen.getByRole('button', { name: /Refresh/ }));
    expect(onRefresh).toHaveBeenCalledTimes(1);
  });

  it('a page whose refresh is heavier can opt out of auto-refresh by default', () => {
    const onRefresh = vi.fn();
    render(<RefreshBar onRefresh={onRefresh} lastUpdated={null} defaultIntervalMs={null} />);
    expect(intervalSelect()).toHaveValue('off');
    vi.advanceTimersByTime(120_000);
    expect(onRefresh).not.toHaveBeenCalled();
  });

  it('a page can opt into a different non-default cadence too', () => {
    const onRefresh = vi.fn();
    render(<RefreshBar onRefresh={onRefresh} lastUpdated={null} defaultIntervalMs={10_000} />);
    expect(intervalSelect()).toHaveValue('10000');
    vi.advanceTimersByTime(10_000);
    expect(onRefresh).toHaveBeenCalledTimes(1);
  });
});
