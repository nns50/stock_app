import { useEffect, useState } from 'react';
import { LogTradeModal } from './PositionForms';

// A single Log-trade modal mounted once in the Layout so a trade can be logged
// from anywhere — opened by the header button, the `n` shortcut, or the
// command palette via an `OPEN_LOG_TRADE` event. On save it broadcasts
// `TRADE_LOGGED` so any open data page (Positions, Today) can refresh itself.

export const OPEN_LOG_TRADE_EVENT = 'open-log-trade';
export const TRADE_LOGGED_EVENT = 'trade-logged';

export function GlobalLogTrade() {
  const [open, setOpen] = useState(false);
  const [initialSymbol, setInitialSymbol] = useState<string | undefined>();
  useEffect(() => {
    const onOpen = (e: Event) => {
      // A plain Event (header / `n`) opens a blank form; a CustomEvent with a
      // `symbol` (a setup row / chart) prefills it.
      setInitialSymbol((e as CustomEvent<{ symbol?: string }>).detail?.symbol);
      setOpen(true);
    };
    window.addEventListener(OPEN_LOG_TRADE_EVENT, onOpen);
    return () => window.removeEventListener(OPEN_LOG_TRADE_EVENT, onOpen);
  }, []);
  return (
    <LogTradeModal
      open={open}
      initialSymbol={initialSymbol}
      onClose={() => setOpen(false)}
      onSaved={() => window.dispatchEvent(new Event(TRADE_LOGGED_EVENT))}
    />
  );
}
