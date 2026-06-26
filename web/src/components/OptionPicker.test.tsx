import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { ExpirySelect, StrikeSelect, chainStrikes, suggestedNet } from './OptionPicker';
import type { OptionsChain, OptionContract } from '../api/types';

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

describe('suggestedNet', () => {
  const mk = (type: 'call' | 'put', strike: number, mark: number): OptionContract => ({
    symbol: `${type}${strike}`,
    underlying: 'X',
    type,
    strike,
    expiration: 'E',
    mark,
  });
  const chainOf = (calls: OptionContract[], puts: OptionContract[], underlyingPrice?: number): OptionsChain => ({
    underlying: 'X',
    expiration: 'E',
    underlyingPrice,
    calls,
    puts,
  });

  it('debit call vertical: net = buy − sell marks, side Buy', () => {
    const chain = chainOf([mk('call', 100, 2), mk('call', 105, 0.8)], []);
    expect(
      suggestedNet(
        chain,
        [
          { side: 'buy', optionType: 'call', strike: 100 },
          { side: 'sell', optionType: 'call', strike: 105 },
        ],
        'VERTICAL',
      ),
    ).toEqual({ limit: 1.2, side: 'buy' });
  });

  it('credit put vertical: side Sell, limit = |net|', () => {
    const chain = chainOf([], [mk('put', 95, 2), mk('put', 90, 0.8)]);
    expect(
      suggestedNet(
        chain,
        [
          { side: 'sell', optionType: 'put', strike: 95 },
          { side: 'buy', optionType: 'put', strike: 90 },
        ],
        'VERTICAL',
      ),
    ).toEqual({ limit: 1.2, side: 'sell' });
  });

  it('iron condor nets both spreads to a credit', () => {
    const chain = chainOf([mk('call', 110, 1.0), mk('call', 115, 0.4)], [mk('put', 95, 1.0), mk('put', 90, 0.4)]);
    expect(
      suggestedNet(
        chain,
        [
          { side: 'buy', optionType: 'put', strike: 90 },
          { side: 'sell', optionType: 'put', strike: 95 },
          { side: 'sell', optionType: 'call', strike: 110 },
          { side: 'buy', optionType: 'call', strike: 115 },
        ],
        'IRON_CONDOR',
      ),
    ).toEqual({ limit: 1.2, side: 'sell' });
  });

  it('covered call: net debit = underlying − call mark, side Buy', () => {
    const chain = chainOf([mk('call', 7, 0.5)], [], 6.9);
    expect(suggestedNet(chain, [{ side: 'sell', optionType: 'call', strike: 7 }], 'COVERED')).toEqual({
      limit: 6.4,
      side: 'buy',
    });
  });

  it('returns undefined when a mark (or chain) is missing', () => {
    const chain = chainOf([mk('call', 100, 2)], []); // no 105 mark
    expect(
      suggestedNet(
        chain,
        [
          { side: 'buy', optionType: 'call', strike: 100 },
          { side: 'sell', optionType: 'call', strike: 105 },
        ],
        'VERTICAL',
      ),
    ).toBeUndefined();
    expect(suggestedNet(null, [], 'VERTICAL')).toBeUndefined();
  });
});
