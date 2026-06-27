import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { Field, Segmented } from './ui';

describe('Field', () => {
  it('renders a Segmented as a labelled role="group" (not a label): no click-forwarding, clean names', () => {
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

    // It's a labelled group, NOT a <label> wrapping the buttons.
    expect(container.querySelector('label')).toBeNull();
    expect(screen.getByRole('group', { name: 'Strategy' })).toBeInTheDocument();

    // Clicking the caption or the group padding does NOT flip the toggle (no
    // forwarding — this was the Strategy-tile reset bug).
    fireEvent.click(screen.getByText('Strategy'));
    fireEvent.click(screen.getByRole('group', { name: 'Strategy' }));
    expect(onChange).not.toHaveBeenCalled();

    // The tab's accessible name is clean ("Single", not "Strategy Single").
    expect(screen.getByRole('tab', { name: 'Single' })).toBeInTheDocument();

    // A direct click on a button still selects it.
    fireEvent.click(screen.getByText('Single'));
    expect(onChange).toHaveBeenCalledWith('SINGLE');
  });

  it('keeps a <label> with click-to-focus for a wrapped input', () => {
    const { container } = render(
      <Field label="Strike">
        <input className="input" />
      </Field>,
    );
    const label = container.querySelector('label') as HTMLLabelElement;
    expect(label).not.toBeNull();
    // First control is an <input>, not a <button>, so the label still forwards
    // the click (fireEvent returns true: nothing called preventDefault).
    expect(fireEvent.click(label)).toBe(true);
  });
});
