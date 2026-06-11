import { useState } from 'react';
import { client } from '../api/client';
import { cx } from '../lib/format';
import { useProvider } from './ProviderContext';
import { Modal } from './ui';
import type { ProviderTestResult } from '../api/types';

export function ProviderStatusModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { status } = useProvider();
  const [result, setResult] = useState<ProviderTestResult>();
  const [testing, setTesting] = useState(false);
  const [error, setError] = useState<string>();

  const run = async () => {
    setTesting(true);
    setError(undefined);
    setResult(undefined);
    try {
      setResult(await client.testProvider());
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setTesting(false);
    }
  };

  return (
    <Modal open={open} onClose={onClose} title="Market data provider">
      {!status ? null : (
        <div className="space-y-3 text-sm">
          <div className="grid grid-cols-2 gap-3">
            <div>
              <div className="label">Provider</div>
              <div className="font-medium">{status.name}</div>
            </div>
            <div>
              <div className="label">Mode</div>
              <div className={cx('font-medium', !status.configured ? 'text-bear' : status.synthetic ? 'text-amber-400' : 'text-bull')}>
                {!status.configured ? 'not configured' : status.synthetic ? 'demo (synthetic)' : 'live'}
              </div>
            </div>
          </div>

          {status.message && <p className="text-xs text-slate-400">{status.message}</p>}

          <div>
            <div className="label">Capabilities</div>
            <div className="flex flex-wrap gap-1.5">
              {Object.entries(status.capabilities).map(([k, v]) => (
                <span key={k} className={cx('chip', v ? 'bg-bull/15 text-bull' : 'bg-ink-600 text-slate-500')}>
                  {v ? '✓' : '✕'} {k}
                </span>
              ))}
            </div>
          </div>

          <div className="border-t border-ink-700 pt-3">
            <button className="btn-primary" onClick={run} disabled={testing}>
              {testing ? 'Testing…' : 'Run connection test'}
            </button>
            <p className="text-[11px] text-slate-500 mt-1">
              Makes real provider calls — use this to confirm a Tradier token works after setting it in <code>server/.env</code>.
            </p>
          </div>

          {error && <div className="text-bear">{error}</div>}

          {result && (
            <div className="space-y-1">
              <div className={cx('font-medium', result.ok ? 'text-bull' : 'text-bear')}>
                {result.ok ? '✓ All checks passed' : '✗ Some checks failed'}{' '}
                <span className="text-slate-500 font-normal">
                  ({result.provider}, {result.symbol})
                </span>
              </div>
              {result.checks.map((c) => (
                <div key={c.name} className="flex items-center justify-between tabular-nums">
                  <span className={c.ok ? 'text-slate-300' : 'text-bear'}>
                    {c.ok ? '✓' : '✗'} {c.name}
                  </span>
                  <span className="text-slate-500 text-xs">
                    {c.detail} · {c.ms}ms
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </Modal>
  );
}
