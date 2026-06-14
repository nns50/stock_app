import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import { ToastProvider, useToast } from './ToastContext';

function Trigger({ withAction, onUndo }: { withAction?: boolean; onUndo?: () => void }) {
  const { toast } = useToast();
  return (
    <button
      onClick={() =>
        toast('Saved', {
          type: 'success',
          action: withAction ? { label: 'Undo', onClick: onUndo ?? (() => {}) } : undefined,
        })
      }
    >
      go
    </button>
  );
}

afterEach(() => vi.useRealTimers());

describe('ToastContext', () => {
  it('shows a toast on demand and runs its action, then dismisses', () => {
    const onUndo = vi.fn();
    render(
      <ToastProvider>
        <Trigger withAction onUndo={onUndo} />
      </ToastProvider>,
    );
    fireEvent.click(screen.getByText('go'));
    expect(screen.getByText('Saved')).toBeInTheDocument();

    fireEvent.click(screen.getByText('Undo'));
    expect(onUndo).toHaveBeenCalledOnce();
    expect(screen.queryByText('Saved')).toBeNull();
  });

  it('auto-dismisses a plain toast after its timeout', () => {
    vi.useFakeTimers();
    render(
      <ToastProvider>
        <Trigger />
      </ToastProvider>,
    );
    fireEvent.click(screen.getByText('go'));
    expect(screen.getByText('Saved')).toBeInTheDocument();

    act(() => {
      vi.advanceTimersByTime(4000);
    });
    expect(screen.queryByText('Saved')).toBeNull();
  });
});
