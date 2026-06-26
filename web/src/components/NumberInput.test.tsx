import { describe, it, expect } from 'vitest';
import { useState } from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import { NumberInput } from './ui';

// A controlled harness mirroring real usage (parent holds the number, feeds it back).
function Harness() {
  const [v, setV] = useState<number | undefined>(undefined);
  return (
    <div>
      <NumberInput value={v} onChange={setV} />
      <span data-testid="val">{v === undefined ? 'undef' : String(v)}</span>
    </div>
  );
}

describe('NumberInput', () => {
  it('preserves an in-progress decimal point ("0." is not clobbered to "0")', () => {
    render(<Harness />);
    const input = screen.getByRole('textbox') as HTMLInputElement;

    fireEvent.change(input, { target: { value: '0' } });
    expect(input.value).toBe('0');
    expect(screen.getByTestId('val').textContent).toBe('0');

    // The bug: a number input would reset this to "0"; a text field keeps it.
    fireEvent.change(input, { target: { value: '0.' } });
    expect(input.value).toBe('0.');

    fireEvent.change(input, { target: { value: '0.5' } });
    expect(input.value).toBe('0.5');
    expect(screen.getByTestId('val').textContent).toBe('0.5');
  });

  it('drops a leading zero once a real digit follows it (default "0" + "4" → "4")', () => {
    render(<Harness />);
    const input = screen.getByRole('textbox') as HTMLInputElement;

    fireEvent.change(input, { target: { value: '0' } }); // a prefilled default
    expect(input.value).toBe('0');
    fireEvent.change(input, { target: { value: '04' } }); // typed "4" after the 0
    expect(input.value).toBe('4');
    expect(screen.getByTestId('val').textContent).toBe('4');

    // But genuine values keep their zeros.
    fireEvent.change(input, { target: { value: '40' } });
    expect(input.value).toBe('40');
    fireEvent.change(input, { target: { value: '0.5' } });
    expect(input.value).toBe('0.5');
  });

  it('emits undefined when cleared and ignores non-numeric input', () => {
    render(<Harness />);
    const input = screen.getByRole('textbox') as HTMLInputElement;

    fireEvent.change(input, { target: { value: '1.25' } });
    expect(screen.getByTestId('val').textContent).toBe('1.25');

    fireEvent.change(input, { target: { value: '' } });
    expect(screen.getByTestId('val').textContent).toBe('undef');

    fireEvent.change(input, { target: { value: 'abc' } });
    expect(input.value).toBe(''); // rejected, stays empty
  });
});
