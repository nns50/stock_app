import { describe, it, expect } from 'vitest';
import { useState } from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { ConfirmProvider, useConfirm } from './ConfirmContext';

function Trigger() {
  const confirm = useConfirm();
  const [result, setResult] = useState('pending');
  return (
    <div>
      <button
        onClick={async () =>
          setResult(String(await confirm({ title: 'Delete it?', confirmLabel: 'Delete', danger: true })))
        }
      >
        ask
      </button>
      <span data-testid="result">{result}</span>
    </div>
  );
}

function renderTrigger() {
  render(
    <ConfirmProvider>
      <Trigger />
    </ConfirmProvider>,
  );
}

describe('ConfirmContext', () => {
  it('resolves true when confirmed', async () => {
    renderTrigger();
    fireEvent.click(screen.getByText('ask'));
    expect(screen.getByText('Delete it?')).toBeInTheDocument();

    fireEvent.click(screen.getByText('Delete'));
    await waitFor(() => expect(screen.getByTestId('result')).toHaveTextContent('true'));
    expect(screen.queryByText('Delete it?')).toBeNull();
  });

  it('resolves false when cancelled', async () => {
    renderTrigger();
    fireEvent.click(screen.getByText('ask'));
    fireEvent.click(screen.getByText('Cancel'));
    await waitFor(() => expect(screen.getByTestId('result')).toHaveTextContent('false'));
  });
});
