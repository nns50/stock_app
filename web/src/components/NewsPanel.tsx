import { ExternalLink } from 'lucide-react';
import { client } from '../api/client';
import { useAsync } from '../lib/hooks';
import { CollapsibleCard, Spinner } from './ui';

function timeAgo(iso?: string): string {
  if (!iso) return '';
  const ms = Date.now() - Date.parse(iso);
  if (Number.isNaN(ms)) return '';
  const mins = Math.round(ms / 60_000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.round(hrs / 24)}d ago`;
}

/** Recent headlines for a symbol (Yahoo) — catalyst context. Headlines + links only. */
export function NewsPanel({ symbol }: { symbol: string }) {
  const news = useAsync(() => client.news(symbol), [symbol]);
  const items = news.data?.news ?? [];

  return (
    <CollapsibleCard
      id="symbol.news"
      title={
        <span>
          News <span className="text-[10px] uppercase tracking-wide text-slate-500 font-normal">Yahoo</span>
        </span>
      }
    >
      {news.loading ? (
        <Spinner />
      ) : items.length === 0 ? (
        <div className="text-xs text-slate-500">No recent headlines.</div>
      ) : (
        <ul className="space-y-2.5">
          {items.map((n, i) => (
            <li key={i}>
              <a href={n.link} target="_blank" rel="noopener noreferrer" className="group block">
                <span className="text-sm text-slate-200 group-hover:text-accent">{n.title}</span>
                <div className="mt-0.5 flex items-center gap-1.5 text-[11px] text-slate-500">
                  {n.publisher && <span>{n.publisher}</span>}
                  {n.publishedAt && <span>· {timeAgo(n.publishedAt)}</span>}
                  <ExternalLink className="h-3 w-3 opacity-0 transition-opacity group-hover:opacity-100" />
                </div>
              </a>
            </li>
          ))}
        </ul>
      )}
    </CollapsibleCard>
  );
}
