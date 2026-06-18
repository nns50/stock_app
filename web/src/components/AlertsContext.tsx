import { createContext, ReactNode, useCallback, useContext, useEffect, useRef, useState } from 'react';
import { client } from '../api/client';
import { useLocalStorage, usePolling } from '../lib/hooks';
import { notifyAlert } from '../lib/notify';
import { useToast } from './ToastContext';

// ---------------------------------------------------------------------------
// App-wide alert poller. Optionally evaluates alerts on an interval (default
// OFF, persisted), keeps a triggered count for the nav bell, and raises toasts
// (via the shared toast stack) when alerts newly fire — so triggers surface
// anywhere in the app, not just on the Alerts page.
// ---------------------------------------------------------------------------

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
  const { toast } = useToast();
  // Exit alerts are stateless each poll; remember which we've toasted so a
  // standing exit notifies once but can re-fire if it clears and recurs.
  const notifiedExits = useRef<Set<string>>(new Set());

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
      for (const t of r.newlyTriggered) {
        const msg = t.message || `${t.symbol} triggered`;
        toast(msg, { type: 'info' });
        notifyAlert('Alert triggered', msg);
      }

      // Position exit alerts: toast keys not seen last round; re-arm cleared ones.
      const seen = new Set<string>();
      for (const e of r.positionAlerts) {
        const key = `${e.positionId}:${e.rule}`;
        seen.add(key);
        if (!notifiedExits.current.has(key)) {
          toast(e.message, { type: 'info' });
          notifyAlert('Position alert', e.message);
        }
      }
      notifiedExits.current = seen;
      setExitCount(r.positionAlerts.length);
    } catch {
      // ignore — provider may be unavailable
    }
  }, [toast]);

  useEffect(() => {
    refreshCount();
  }, [refreshCount]);
  usePolling(checkNow, intervalMs);

  return (
    <Ctx.Provider
      value={{ triggeredCount: symbolCount + exitCount, intervalMs, setIntervalMs, checkNow, refreshCount }}
    >
      {children}
    </Ctx.Provider>
  );
}

export const useAlerts = () => useContext(Ctx);
