import { createContext, ReactNode, useCallback, useContext, useEffect, useRef, useState } from 'react';
import { client } from '../api/client';
import { useLocalStorage, usePolling } from '../lib/hooks';

// ---------------------------------------------------------------------------
// App-wide alert poller. Optionally evaluates alerts on an interval (default
// OFF, persisted), keeps a triggered count for the nav bell, and raises toasts
// when alerts newly fire — so triggers surface anywhere in the app, not just on
// the Alerts page.
// ---------------------------------------------------------------------------

interface Toast {
  id: number;
  message: string;
}

interface AlertsCtx {
  triggeredCount: number;
  intervalMs: number | null;
  setIntervalMs: (ms: number | null) => void;
  checkNow: () => Promise<void>;
  refreshCount: () => Promise<void>;
}

const Ctx = createContext<AlertsCtx>({
  triggeredCount: 0,
  intervalMs: null,
  setIntervalMs: () => {},
  checkNow: async () => {},
  refreshCount: async () => {},
});

export function AlertsProvider({ children }: { children: ReactNode }) {
  const [symbolCount, setSymbolCount] = useState(0);
  const [exitCount, setExitCount] = useState(0);
  const [intervalMs, setIntervalMs] = useLocalStorage<number | null>('alerts.pollMs', null);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const nextId = useRef(0);
  // Exit alerts are stateless each poll; remember which we've toasted so a
  // standing exit notifies once but can re-fire if it clears and recurs.
  const notifiedExits = useRef<Set<string>>(new Set());

  const pushToast = useCallback((message: string) => {
    const id = ++nextId.current;
    setToasts((t) => [...t, { id, message }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 9000);
  }, []);
  const dismiss = (id: number) => setToasts((t) => t.filter((x) => x.id !== id));

  // Cheap badge refresh: read current state without re-evaluating.
  const refreshCount = useCallback(async () => {
    try {
      const r = await client.alerts();
      setSymbolCount(r.alerts.filter((a) => a.triggered).length);
    } catch {
      // ignore — provider may be unavailable
    }
  }, []);

  // Evaluate against current data; toast anything that newly fired.
  const checkNow = useCallback(async () => {
    try {
      const r = await client.evaluateAlerts();
      setSymbolCount(r.alerts.filter((a) => a.triggered).length);
      for (const t of r.newlyTriggered) pushToast(t.message || `${t.symbol} triggered`);

      // Position exit alerts: toast keys not seen last round; re-arm cleared ones.
      const seen = new Set<string>();
      for (const e of r.positionAlerts) {
        const key = `${e.positionId}:${e.rule}`;
        seen.add(key);
        if (!notifiedExits.current.has(key)) pushToast(e.message);
      }
      notifiedExits.current = seen;
      setExitCount(r.positionAlerts.length);
    } catch {
      // ignore — provider may be unavailable
    }
  }, [pushToast]);

  useEffect(() => {
    refreshCount();
  }, [refreshCount]);
  usePolling(checkNow, intervalMs);

  return (
    <Ctx.Provider
      value={{ triggeredCount: symbolCount + exitCount, intervalMs, setIntervalMs, checkNow, refreshCount }}
    >
      {children}
      {toasts.length > 0 && (
        <div className="fixed bottom-4 right-4 z-50 w-80 space-y-2">
          {toasts.map((t) => (
            <div
              key={t.id}
              className="card bg-ink-800 border-amber-500/40 p-3 text-sm flex items-start gap-2 shadow-xl"
            >
              <span className="text-amber-400">🔔</span>
              <span className="flex-1">{t.message}</span>
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

export const useAlerts = () => useContext(Ctx);
