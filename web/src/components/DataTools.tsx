import { useRef, useState } from 'react';
import { client, ApiError } from '../api/client';
import { parseTradeCsv } from '../lib/tradeCsv';
import { useToast } from './ToastContext';

type Pending = { positions: unknown[]; fileName: string };

/**
 * Export / backup / restore controls. Downloads are plain links to the export
 * endpoints (proxied to the API). Import reads a positions.json file (or a trade
 * CSV — a spreadsheet journal or broker export), then asks whether to append or
 * replace before sending it — replace is destructive, so it's never the default.
 */
export function DataTools({ onImported }: { onImported: () => void }) {
  const fileRef = useRef<HTMLInputElement>(null);
  const csvRef = useRef<HTMLInputElement>(null);
  const [pending, setPending] = useState<Pending | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const { toast } = useToast();

  const onFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = ''; // allow re-picking the same file
    if (!file) return;
    setMsg(null);
    try {
      const parsed: unknown = JSON.parse(await file.text());
      const positions = Array.isArray(parsed) ? parsed : ((parsed as { positions?: unknown }).positions ?? null);
      if (!Array.isArray(positions)) throw new Error('Not a positions export (expected a positions array).');
      if (positions.length === 0) throw new Error('That file contains no positions.');
      setPending({ positions, fileName: file.name });
    } catch (err) {
      setMsg({ ok: false, text: err instanceof Error ? err.message : 'Could not read file' });
    }
  };

  const onCsvFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    setMsg(null);
    try {
      const { positions, errors } = parseTradeCsv(await file.text());
      if (positions.length === 0) {
        setMsg({ ok: false, text: errors[0] ?? 'No valid trades found in that CSV.' });
        return;
      }
      setPending({ positions, fileName: file.name });
      if (errors.length) setMsg({ ok: false, text: `${errors.length} row(s) skipped — ${errors[0]}` });
    } catch (err) {
      setMsg({ ok: false, text: err instanceof Error ? err.message : 'Could not read CSV' });
    }
  };

  const doImport = async (mode: 'merge' | 'replace') => {
    if (!pending) return;
    setBusy(true);
    setMsg(null);
    try {
      const res = await client.importPositions(pending.positions, mode);
      setMsg({
        ok: true,
        text: `Imported ${res.imported}${res.replaced ? ' (replaced existing)' : ''} — ${res.totalNow} total.`,
      });
      setPending(null);
      onImported();
      toast(`Imported ${res.imported} position(s)`, { type: 'success' });
    } catch (err) {
      const text = err instanceof ApiError ? err.message : 'Import failed';
      setMsg({ ok: false, text });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-col items-end gap-1 text-xs">
      <div className="flex items-center gap-1.5">
        <span className="text-slate-500">Data:</span>
        <a
          className="btn-ghost !py-1 !px-2"
          href="/api/export/positions.csv"
          download
          title="Spreadsheet of all trades"
        >
          CSV
        </a>
        <a
          className="btn-ghost !py-1 !px-2"
          href="/api/export/positions.json"
          download
          title="Re-importable trade export"
        >
          JSON
        </a>
        <a
          className="btn-ghost !py-1 !px-2"
          href="/api/export/backup.db"
          download
          title="Full SQLite snapshot (positions, journal, presets, settings, alerts)"
        >
          Backup .db
        </a>
        <button
          className="btn-ghost !py-1 !px-2"
          onClick={() => fileRef.current?.click()}
          disabled={busy}
          title="Import a positions.json export"
        >
          Import…
        </button>
        <button
          className="btn-ghost !py-1 !px-2"
          onClick={() => csvRef.current?.click()}
          disabled={busy}
          title="Import trades from a spreadsheet or broker CSV"
        >
          Import CSV…
        </button>
        <input ref={fileRef} type="file" accept="application/json,.json" className="hidden" onChange={onFile} />
        <input ref={csvRef} type="file" accept=".csv,text/csv" className="hidden" onChange={onCsvFile} />
      </div>

      {pending && (
        <div className="flex items-center gap-1.5 text-slate-400">
          <span>
            {pending.fileName}: {pending.positions.length} position(s) —
          </span>
          <button className="btn-ghost !py-1 !px-2" onClick={() => doImport('merge')} disabled={busy}>
            Append
          </button>
          <button
            className="btn-ghost !py-1 !px-2 !text-bear"
            onClick={() => doImport('replace')}
            disabled={busy}
            title="Delete all current positions, then import"
          >
            Replace all
          </button>
          <button className="text-slate-500 hover:text-slate-300" onClick={() => setPending(null)} disabled={busy}>
            cancel
          </button>
        </div>
      )}

      {msg && <span className={msg.ok ? 'text-bull' : 'text-bear'}>{msg.text}</span>}
    </div>
  );
}
