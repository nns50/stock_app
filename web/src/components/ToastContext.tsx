import { createContext, ReactNode, useCallback, useContext, useRef, useState } from 'react';
import { cx } from '../lib/format';

// App-wide toast notifications. One stack, shared by action feedback ("Trade
// logged"), the alert notifier, and anything else that needs to confirm an
// action or offer an Undo.

type ToastType = 'success' | 'error' | 'info';

interface ToastAction {
  label: string;
  onClick: () => void;
}

interface Toast {
  id: number;
  message: string;
  type: ToastType;
  action?: ToastAction;
}

interface ToastApi {
  toast: (message: string, opts?: { type?: ToastType; action?: ToastAction; durationMs?: number }) => void;
}

const Ctx = createContext<ToastApi>({ toast: () => {} });
export const useToast = () => useContext(Ctx);

const ICON: Record<ToastType, string> = { success: '✓', error: '⚠', info: '🔔' };
const BORDER: Record<ToastType, string> = {
  success: 'border-bull/40',
  error: 'border-bear/40',
  info: 'border-amber-500/40',
};
const ICON_COLOR: Record<ToastType, string> = {
  success: 'text-bull',
  error: 'text-bear',
  info: 'text-amber-400',
};

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const nextId = useRef(0);

  const dismiss = useCallback((id: number) => setToasts((t) => t.filter((x) => x.id !== id)), []);

  const toast = useCallback<ToastApi['toast']>((message, opts = {}) => {
    const id = ++nextId.current;
    setToasts((prev) => [...prev, { id, message, type: opts.type ?? 'info', action: opts.action }]);
    const duration = opts.durationMs ?? (opts.action ? 8000 : 4000);
    setTimeout(() => setToasts((prev) => prev.filter((x) => x.id !== id)), duration);
  }, []);

  return (
    <Ctx.Provider value={{ toast }}>
      {children}
      {toasts.length > 0 && (
        <div className="fixed bottom-4 right-4 z-[70] w-80 space-y-2">
          {toasts.map((t) => (
            <div
              key={t.id}
              role="status"
              className={cx('card bg-ink-800 p-3 text-sm flex items-start gap-2 shadow-xl border', BORDER[t.type])}
            >
              <span className={ICON_COLOR[t.type]}>{ICON[t.type]}</span>
              <span className="flex-1">{t.message}</span>
              {t.action && (
                <button
                  className="text-accent text-xs font-medium hover:underline"
                  onClick={() => {
                    t.action!.onClick();
                    dismiss(t.id);
                  }}
                >
                  {t.action.label}
                </button>
              )}
              <button
                className="text-slate-500 hover:text-slate-300"
                onClick={() => dismiss(t.id)}
                aria-label="Dismiss"
              >
                ✕
              </button>
            </div>
          ))}
        </div>
      )}
    </Ctx.Provider>
  );
}
