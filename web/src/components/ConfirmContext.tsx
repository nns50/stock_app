import { createContext, ReactNode, useCallback, useContext, useRef, useState } from 'react';
import { Modal } from './ui';

// A styled, promise-based replacement for window.confirm(): const ok = await
// confirm({ title, body, confirmLabel, danger }).

interface ConfirmOptions {
  title: string;
  body?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  danger?: boolean;
}

const Ctx = createContext<(opts: ConfirmOptions) => Promise<boolean>>(() => Promise.resolve(false));
export const useConfirm = () => useContext(Ctx);

export function ConfirmProvider({ children }: { children: ReactNode }) {
  const [opts, setOpts] = useState<ConfirmOptions | null>(null);
  const resolver = useRef<((v: boolean) => void) | undefined>(undefined);

  const confirm = useCallback((o: ConfirmOptions) => {
    setOpts(o);
    return new Promise<boolean>((resolve) => {
      resolver.current = resolve;
    });
  }, []);

  const settle = (v: boolean) => {
    resolver.current?.(v);
    resolver.current = undefined;
    setOpts(null);
  };

  return (
    <Ctx.Provider value={confirm}>
      {children}
      <Modal
        open={opts !== null}
        onClose={() => settle(false)}
        title={opts?.title ?? ''}
        footer={
          <>
            <button className="btn-ghost" onClick={() => settle(false)}>
              {opts?.cancelLabel ?? 'Cancel'}
            </button>
            <button className={opts?.danger ? 'btn-danger' : 'btn-primary'} onClick={() => settle(true)}>
              {opts?.confirmLabel ?? 'Confirm'}
            </button>
          </>
        }
      >
        <p className="text-sm text-slate-300">{opts?.body ?? 'Are you sure?'}</p>
      </Modal>
    </Ctx.Provider>
  );
}
