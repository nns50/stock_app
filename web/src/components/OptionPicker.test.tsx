import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { ExpirySelect, StrikeSelect, chainStrikes } from './OptionPicker';
import type { OptionsChain } from '../api/types';

const c = (type: 'call' | 'put', strike: number) => ({
  symbol: `${type}${strike}`,
  underlying: 'AMC',
  type,
  strike,
  expiration: '2026-07-17',
});
const chain = {
  underlying: 'AMC',
  expiration: '2026-07-17',
  calls: [c('call', 7), c('call', 6), c('call', 7)], // out of order + a duplicate
  puts: [c('put', 5)],
} as OptionsChain;

describe('chainStrikes', () => {
  it('returns sorted, de-duplicated strikes for the chosen side', () => {
    expect(chainStrikes(chain, 'call')).toEqual([6, 7]);
    expect(chainStrikes(chain, 'put')).toEqual([5]);
  });
  it('is empty when there is no chain', () => {
    expect(chainStrikes(null, 'call')).toEqual([]);
    expect(chainStrikes(undefined, 'put')).toEqual([]);
  });
});

describe('ExpirySelect', () => {
  it('renders a dropdown of expirations and emits the chosen one', () => {
    const onChange = vi.fn();
    render(<ExpirySelect value="" options={['2026-07-17', '2026-08-21']} onChange={onChange} />);
    fireEvent.change(screen.getByRole('combobox'), { target: { value: '2026-08-21' } });
    expect(onChange).toHaveBeenCalledWith('2026-08-21');
  });
  it('falls back to a free-text input when no expirations are available', () => {
    const onChange = vi.fn();
    render(<ExpirySelect value="" options={[]} onChange={onChange} />);
    fireEvent.change(screen.getByPlaceholderText('YYYY-MM-DD'), { target: { value: '2026-09-18' } });
    expect(onChange).toHaveBeenCalledWith('2026-09-18');
  });
});

describe('StrikeSelect', () => {
  it('renders a dropdown of strikes and emits a number', () => {
    const onChange = vi.fn();
    render(<StrikeSelect value={undefined} options={[6, 7, 8]} onChange={onChange} />);
    fireEvent.change(screen.getByRole('combobox'), { target: { value: '7' } });
    expect(onChange).toHaveBeenCalledWith(7);
  });
  it('falls back to a numeric input when no strikes are available', () => {
    const onChange = vi.fn();
    render(<StrikeSelect value={undefined} options={[]} onChange={onChange} />);
    fireEvent.change(screen.getByRole('textbox'), { target: { value: '6.5' } });
    expect(onChange).toHaveBeenCalledWith(6.5);
  });
});
