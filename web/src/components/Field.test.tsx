import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { Field, Segmented } from './ui';

describe('Field', () => {
  it('cancels a label click that would forward to a wrapped button group (Segmented)', () => {
    const onChange = vi.fn();
    const { container } = render(
      <Field label="Strategy">
        <Segmented
          value="VERTICAL"
          onChange={onChange}
          options={[
            { value: 'SINGLE', label: 'Single' },
            { value: 'VERTICAL', label: 'Vertical' },
          ]}
        />
      </Field>,
    );
    const label = container.querySelector('label') as HTMLLabelElement;

    // Clicking the label's padding (not a button) must NOT flip the toggle, and
    // the label's default forwarding is cancelled — fireEvent returns false when
    // a handler calls preventDefault(). This is the reported bug: clicking the
    // empty part of the Strategy tile flipped Vertical→Single and wiped the form.
    expect(fireEvent.click(label)).toBe(false);
    expect(onChange).not.toHaveBeenCalled();

    // The caption text is also a non-control click → forwarding still cancelled.
    expect(fireEvent.click(screen.getByText('Strategy'))).toBe(false);
    expect(onChange).not.toHaveBeenCalled();

    // Sanity: a direct click on a button still selects it.
    fireEvent.click(screen.getByText('Single'));
    expect(onChange).toHaveBeenCalledWith('SINGLE');
  });

  it('keeps label click-to-focus for a wrapped text input (forwarding not cancelled)', () => {
    const { container } = render(
      <Field label="Strike">
        <input className="input" />
      </Field>,
    );
    const label = container.querySelector('label') as HTMLLabelElement;
    // The first control is an <input>, not a <button>, so the label still
    // forwards the click (fireEvent returns true: nothing called preventDefault).
    expect(fireEvent.click(label)).toBe(true);
  });
});
