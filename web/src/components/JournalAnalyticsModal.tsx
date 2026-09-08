import { useEffect, useState } from 'react';
import { client } from '../api/client';
import { useAsync } from '../lib/hooks';
import { cx, fmtDate, fmtNum, fmtPct, fmtSignedUsd, fmtUsd } from '../lib/format';
import { EmptyState, ErrorState, Field, Modal, NumberInput, Segmented, Spinner, StatTile } from './ui';
import type { RuinResult } from '../api/types';

type Tab = 'excursions' | 'slippage' | 'overrun' | 'tighten' | 'ruin';

const r = (v: number | null) => (v == null ? '—' : `${v >= 0 ? '+' : ''}${fmtNum(v, 2)}R`);
const rClass = (v: number | null) => (v == null ? '' : v >= 0 ? 'text-bull' : 'text-bear');
// Positive $/% always means the fill cost you money (regardless of buy/sell); see
// server/src/services/slippage.ts.
const costClass = (v: number) => (v > 0 ? 'text-bear' : v < 0 ? 'text-bull' : '');

/**
 * Journal's three trade-quality reports (Excursions, Execution quality, Risk of
 * ruin), under one modal with a tab switcher instead of three separate popups.
 * Each tab fetches lazily — only while it's the active tab of an open modal.
 */
export function JournalAnalyticsModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [tab, setTab] = useState<Tab>('excursions');

  return (
    <Modal open={open} onClose={onClose} title="Journal analytics" wide>
      <div className="space-y-3">
        <Field label="Report">
          <Segmented
            value={tab}
            onChange={(v) => setTab(v as Tab)}
            options={[
              { value: 'excursions', label: 'Excursions' },
              { value: 'slippage', label: 'Execution quality' },
              { value: 'overrun', label: 'Stop overrun' },
              { value: 'tighten', label: 'Regime tighten' },
              { value: 'ruin', label: 'Risk of ruin' },
            ]}
          />
        </Field>
        {tab === 'excursions' && <ExcursionsPanel active={open && tab === 'excursions'} />}
        {tab === 'slippage' && <SlippagePanel active={open && tab === 'slippage'} />}
        {tab === 'overrun' && <StopOverrunPanel active={open && tab === 'overrun'} />}
        {tab === 'tighten' && <RegimeTightenPanel active={open && tab === 'tighten'} />}
        {tab === 'ruin' && <RuinPanel active={open && tab === 'ruin'} />}
      </div>
    </Modal>
  );
}

/** MAE/MFE excursion analysis: how far each closed stock trade ran for/against you
 *  over its holding period (in R), and how much of the favorable move you kept. */
function ExcursionsPanel({ active }: { active: boolean }) {
  const data = useAsync(() => (active ? client.journalExcursions() : Promise.resolve(null)), [active]);

  if (data.loading) return <Spinner label="Fetching candles per trade…" />;
  if (data.error) return <ErrorState error={data.error} onRetry={data.reload} />;
  if (!data.data || data.data.trades === 0) {
    // "No closed stock trades" is only true when there genuinely are none. If
    // trades exist but every candle fetch failed, or they're all undated, saying
    // that is a lie in the same shape as the truncation this endpoint used to
    // hide — so read the coverage and say which it is.
    const c = data.data?.coverage;
    const hadTrades = (c?.closedStockTrades ?? 0) > 0;
    return (
      <EmptyState
        title={hadTrades ? 'Nothing could be measured' : 'No closed stock trades to analyze'}
        hint={
          hadTrades
            ? `${c!.closedStockTrades} closed stock trade(s), none of them analysable: ` +
              [
                c!.undated ? `${c!.undated} without an entry date` : null,
                c!.unavailable ? `${c!.unavailable} with no candle data available` : null,
                c!.overCap ? `${c!.overCap} beyond this request's cap` : null,
              ]
                .filter(Boolean)
                .join(', ') +
              '. An excursion needs daily candles across the holding period.'
            : "Excursions use daily candles over each closed stock trade's holding period (options are skipped). Log a stop to see results in R."
        }
      />
    );
  }
  const cov = data.data.coverage;
  const excluded = cov.undated + cov.overCap + cov.unavailable;
  // A same-session trade measured on a DAILY bar gets that whole day's high and
  // low — including hours it wasn't held — so those rows are an upper bound, not
  // a measurement. Worth saying when any of them are in the average.
  const mix = data.data.resolutionMix;
  return (
    <div className="space-y-3">
      <p className="text-xs text-slate-500">
        Over each trade’s holding period: how far price ran in your favor (MFE) and against you (MAE), in R. Compare avg
        MFE to avg realized — a big gap means winners ran further than you held.
      </p>
      {excluded > 0 && (
        // These averages are a SAMPLE. Saying so is the difference between a
        // number you can act on and one you only think you can.
        <p className="text-[11px] text-amber-400/90">
          Averages over {data.data.trades} of {cov.closedStockTrades} closed stock trades.{' '}
          {[
            cov.undated ? `${cov.undated} have no entry date` : null,
            cov.unavailable ? `${cov.unavailable} had no candle data` : null,
            cov.overCap ? `${cov.overCap} beyond this request's cap` : null,
          ]
            .filter(Boolean)
            .join(' · ')}
          .
        </p>
      )}
      {mix != null && mix.daily > 0 && mix.intraday > 0 && (
        <p className="text-[11px] text-slate-500">
          {mix.intraday} measured on intraday bars, {mix.daily} on daily. A trade opened and closed the same session
          reads that whole day’s range on a daily bar — treat those rows as an upper bound.
        </p>
      )}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
        <StatTile label="Avg MFE" value={r(data.data.avgMfeR)} valueClass="text-bull" sub="best run" />
        <StatTile label="Avg MAE" value={r(data.data.avgMaeR)} valueClass="text-bear" sub="worst dip" />
        <StatTile label="Avg realized" value={r(data.data.avgRealizedR)} valueClass={rClass(data.data.avgRealizedR)} />
        <StatTile
          label="Capture"
          value={data.data.capturePct == null ? '—' : `${fmtNum(data.data.capturePct, 0)}%`}
          sub="of the move kept"
        />
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-[11px] uppercase tracking-wide text-slate-500 border-b border-ink-600/60">
              <th className="py-1 pr-2 font-medium">Symbol</th>
              <th className="py-1 px-2 font-medium">Entry</th>
              <th className="py-1 px-2 font-medium text-right">MFE</th>
              <th className="py-1 px-2 font-medium text-right">MAE</th>
              <th className="py-1 px-2 font-medium text-right">Realized</th>
              <th className="py-1 pl-2 font-medium text-right">Captured</th>
            </tr>
          </thead>
          <tbody>
            {data.data.rows.map((row) => (
              <tr key={row.positionId} className="border-b border-ink-700/40 last:border-0">
                <td className="py-1 pr-2 font-medium text-slate-200">
                  {row.symbol} <span className="text-[11px] text-slate-500">{row.side}</span>
                </td>
                <td className="py-1 px-2 text-slate-400 text-xs">{row.entryDate}</td>
                <td className="py-1 px-2 text-right tabular-nums text-bull">{r(row.mfeR)}</td>
                <td className="py-1 px-2 text-right tabular-nums text-bear">{r(row.maeR)}</td>
                <td className={cx('py-1 px-2 text-right tabular-nums', rClass(row.realizedR))}>{r(row.realizedR)}</td>
                <td className="py-1 pl-2 text-right tabular-nums text-slate-400">
                  {row.capturedPct == null ? '—' : `${fmtNum(row.capturedPct, 0)}%`}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="text-[11px] text-slate-500">
        R needs a logged stop. “Captured” = realized ÷ MFE on winners — low values suggest exiting winners early; small
        MAE vs your −1R stop suggests room to tighten.
      </p>
    </div>
  );
}

/** The counterfactual MFE ledger for the ML regime target tighten: for every
 *  closed stock trade whose target was tightened at entry, whether the FULL
 *  (untightened) target would have been reached, from the trade's own best
 *  run — a bound that leans toward the full target, read by a rule written
 *  before the first trade. */
function RegimeTightenPanel({ active }: { active: boolean }) {
  const data = useAsync(() => (active ? client.journalRegimeTighten() : Promise.resolve(null)), [active]);

  if (data.loading) return <Spinner label="Joining tightened trades to their excursions…" />;
  if (data.error) return <ErrorState error={data.error} onRetry={data.reload} />;
  if (!data.data || data.data.n === 0) {
    const c = data.data?.coverage;
    const hadTrades = (c?.tightenedTrades ?? 0) > 0;
    const optionsNote = c?.optionsExcluded
      ? ` ${c.optionsExcluded} closed options trade(s) were tightened too — their excursion is on the underlying, not the premium, so they are not measured here.`
      : '';
    return (
      <EmptyState
        title={hadTrades ? 'Nothing could be measured' : 'No tightened trades yet'}
        hint={
          hadTrades
            ? `${c!.tightenedTrades} closed stock trade(s) carry a tightened target, none of them measurable: ` +
              [
                c!.undated ? `${c!.undated} without an entry date` : null,
                c!.unavailable ? `${c!.unavailable} with no candles, stop or target to measure against` : null,
                c!.overCap ? `${c!.overCap} beyond this request's cap` : null,
              ]
                .filter(Boolean)
                .join(', ') +
              '.' +
              optionsNote
            : 'This ledger fills in once the ML regime overlay is on and stock trades opened under High Volatility/Bearish have closed — each carries the factor its target was tightened by.' +
              optionsNote
        }
      />
    );
  }
  const d = data.data;
  const cov = d.coverage;
  const excluded = cov.undated + cov.overCap + cov.unavailable;
  const pctOf = (k: number) => (d.n ? `${fmtNum((k / d.n) * 100, 0)}% of measured` : '—');
  const readingLabel =
    d.reading === 'tighten_costs'
      ? 'Tighten costs'
      : d.reading === 'tighten_holds'
        ? 'Tighten holds'
        : 'Reading pending';
  const readingClass =
    d.reading === 'tighten_costs'
      ? 'border-amber-500/50 bg-amber-500/5 text-amber-200'
      : d.reading === 'tighten_holds'
        ? 'border-bull/50 bg-bull/5 text-slate-200'
        : 'border-ink-600 bg-ink-800/40 text-slate-300';
  const outcome = (row: (typeof d.rows)[number]) =>
    row.fullReached ? 'full target reached' : row.bankedWin ? 'banked win' : 'missed';
  return (
    <div className="space-y-3">
      <p className="text-xs text-slate-500">
        For each closed stock trade whose profit target the ML regime overlay tightened, the trade’s own best run (MFE)
        says whether the <em>full</em>, untightened target would have been reached. The counterfactual takes the most
        optimistic case for the full target — reached means banked there with no reversal, not reached means the
        untightened trade did as well as this one — so it is read in one direction only.
      </p>
      <p className={cx('rounded-lg border px-3 py-2 text-xs', readingClass)} data-testid="regime-tighten-reading">
        <span className="font-medium">{readingLabel}:</span> {d.readingDetail}
      </p>
      {excluded > 0 && (
        <p className="text-[11px] text-amber-400/90" data-testid="regime-tighten-coverage">
          Over {d.n} of {cov.tightenedTrades} tightened trades.{' '}
          {[
            cov.undated ? `${cov.undated} have no entry date` : null,
            cov.unavailable ? `${cov.unavailable} had no candles, stop or target to measure against` : null,
            cov.overCap ? `${cov.overCap} beyond this request's cap` : null,
          ]
            .filter(Boolean)
            .join(' · ')}
          .
        </p>
      )}
      {cov.optionsExcluded > 0 && (
        <p className="text-[11px] text-slate-500" data-testid="regime-tighten-options">
          {cov.optionsExcluded} closed options trade(s) were tightened too — their excursion is on the underlying, not
          the premium, so they are not measured here.
        </p>
      )}
      {d.resolutionMix.daily > 0 && d.resolutionMix.intraday > 0 && (
        <p className="text-[11px] text-slate-500">
          {d.resolutionMix.intraday} measured on intraday bars, {d.resolutionMix.daily} on daily. A same-session trade
          on a daily bar reads that whole day’s high, so “full target reached” is an upper bound on those rows.
        </p>
      )}
      <div className="grid grid-cols-2 sm:grid-cols-5 gap-2">
        <StatTile label="Tightened trades" value={d.n} sub={`${d.byBook.paper} paper · ${d.byBook.live} live`} />
        <StatTile label="Tightened target hit" value={d.tightenedReached} sub={pctOf(d.tightenedReached)} />
        <StatTile label="Full target reached" value={d.fullReached} sub={pctOf(d.fullReached)} />
        <StatTile label="Banked wins" value={d.bankedWins} sub="hit the tightened target, never the full one" />
        <StatTile
          label="Realized vs counterfactual"
          value={`${r(d.meanRealizedR)} / ${r(d.meanCounterfactualR)}`}
          sub={
            d.difference.meanR == null
              ? '—'
              : `difference ${r(d.difference.meanR)} (95% CI ${r(d.difference.ciLow)} to ${r(d.difference.ciHigh)})`
          }
        />
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-[11px] uppercase tracking-wide text-slate-500 border-b border-ink-600/60">
              <th className="py-1 pr-2 font-medium">Symbol</th>
              <th className="py-1 px-2 font-medium">Entry</th>
              <th className="py-1 px-2 font-medium text-right">Target (traded → full)</th>
              <th className="py-1 px-2 font-medium text-right">MFE</th>
              <th className="py-1 px-2 font-medium text-right">Realized</th>
              <th className="py-1 px-2 font-medium text-right">Counterfactual</th>
              <th className="py-1 pl-2 font-medium">Outcome</th>
            </tr>
          </thead>
          <tbody>
            {d.rows.map((row) => (
              <tr key={`${row.book}-${row.positionId}`} className="border-b border-ink-700/40 last:border-0">
                <td className="py-1 pr-2 font-medium text-slate-200">
                  {row.symbol}{' '}
                  <span className="text-[11px] text-slate-500">
                    {row.book} · {row.side}
                  </span>
                </td>
                <td className="py-1 px-2 text-slate-400 text-xs">{row.entryDate}</td>
                <td className="py-1 px-2 text-right tabular-nums text-slate-300">
                  {fmtNum(row.tightenedTargetR, 2)}R → {fmtNum(row.fullTargetR, 2)}R
                  <span className="text-[11px] text-slate-500"> (×{fmtNum(row.factor, 2)})</span>
                </td>
                <td className="py-1 px-2 text-right tabular-nums text-bull">{r(row.mfeR)}</td>
                <td className={cx('py-1 px-2 text-right tabular-nums', rClass(row.realizedR))}>{r(row.realizedR)}</td>
                <td className={cx('py-1 px-2 text-right tabular-nums', rClass(row.counterfactualR))}>
                  {r(row.counterfactualR)}
                </td>
                <td className="py-1 pl-2 text-xs text-slate-400">{outcome(row)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="text-[11px] text-slate-500">
        Pre-committed: after {d.minTrades} tightened trades, a counterfactual that beats realized R with a CI excluding
        zero means the tighten has a real cost (set it to 0 and re-run the grid); one that cannot means it stays. The
        bound only leans toward the full target, so “the counterfactual lost” is never read as a measured gain.
      </p>
    </div>
  );
}

/** Execution quality: for each live-traded fill that came from an order with a
 *  limit price, how the actual broker fill compared to the price you committed
 *  to. Surfaces silent slippage cost — worst fills first. */
function SlippagePanel({ active }: { active: boolean }) {
  const data = useAsync(() => (active ? client.journalSlippage() : Promise.resolve(null)), [active]);

  if (data.loading) return <Spinner label="Comparing fills to order limits…" />;
  if (data.error) return <ErrorState error={data.error} onRetry={data.reload} />;
  if (!data.data || data.data.trades === 0) {
    return (
      <EmptyState
        title="No live fills to analyze yet"
        hint="This compares each live-traded fill to the order's limit price. It only covers orders placed through this app with a limit (stop-market fills and manually logged/imported trades have no reference price to compare against)."
      />
    );
  }
  return (
    <div className="space-y-3">
      <p className="text-xs text-slate-500">
        For each live fill, the actual broker price vs. the limit you set — positive always means it cost you money,
        whichever side you were on.
      </p>
      <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
        <StatTile
          label="Total slippage"
          value={fmtSignedUsd(data.data.totalUsd)}
          valueClass={costClass(data.data.totalUsd)}
          sub={data.data.totalUsd > 0 ? 'cost you' : data.data.totalUsd < 0 ? 'saved you' : undefined}
        />
        <StatTile
          label="Avg %"
          value={data.data.avgPct == null ? '—' : fmtPct(data.data.avgPct)}
          valueClass={data.data.avgPct == null ? '' : costClass(data.data.avgPct)}
        />
        <StatTile label="Fills with data" value={data.data.trades} />
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-[11px] uppercase tracking-wide text-slate-500 border-b border-ink-600/60">
              <th className="py-1 pr-2 font-medium">Symbol</th>
              <th className="py-1 px-2 font-medium">Date</th>
              <th className="py-1 px-2 font-medium">Kind</th>
              <th className="py-1 px-2 font-medium text-right">Limit</th>
              <th className="py-1 px-2 font-medium text-right">Fill</th>
              <th className="py-1 px-2 font-medium text-right">$</th>
              <th className="py-1 pl-2 font-medium text-right">%</th>
            </tr>
          </thead>
          <tbody>
            {data.data.rows.map((row, i) => (
              <tr key={`${row.positionId}-${row.kind}-${i}`} className="border-b border-ink-700/40 last:border-0">
                <td className="py-1 pr-2 font-medium text-slate-200">
                  {row.symbol} <span className="text-[11px] text-slate-500">{row.side}</span>
                </td>
                <td className="py-1 px-2 text-slate-400 text-xs">{fmtDate(row.date)}</td>
                <td className="py-1 px-2 text-slate-400 text-xs">{row.kind}</td>
                <td className="py-1 px-2 text-right tabular-nums text-slate-400">{fmtUsd(row.limitPrice)}</td>
                <td className="py-1 px-2 text-right tabular-nums text-slate-200">{fmtUsd(row.fillPrice)}</td>
                <td className={cx('py-1 px-2 text-right tabular-nums', costClass(row.totalUsd))}>
                  {fmtSignedUsd(row.totalUsd)}
                </td>
                <td className={cx('py-1 pl-2 text-right tabular-nums', costClass(row.pct))}>{fmtPct(row.pct)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="text-[11px] text-slate-500">
        Sorted worst-first. A consistent positive bias suggests marketable limits or wide spreads at entry/exit —
        tighter limits or more liquid strikes reduce it.
      </p>
    </div>
  );
}

/** Stop overrun: for every stock stop EXECUTION, how far beyond the declared
 *  stop the exit actually landed — the gap/spread cost the zero-cost backtests
 *  can't model, broken down by entry price band. */
function StopOverrunPanel({ active }: { active: boolean }) {
  const data = useAsync(() => (active ? client.journalStopOverrun() : Promise.resolve(null)), [active]);

  if (data.loading) return <Spinner label="Comparing stop executions to declared stops…" />;
  if (data.error) return <ErrorState error={data.error} onRetry={data.reload} />;
  if (!data.data || data.data.trades === 0) {
    return (
      <EmptyState
        title="No stop executions to analyze yet"
        hint="This measures each stock exit that was a stop execution against the position's declared stop price. It needs positions with a logged stop whose exits either carry the 'stop' exit reason (recorded automatically for auto-traded positions since 2026-07-26) or landed at/beyond the stop."
      />
    );
  }
  const d = data.data;
  return (
    <div className="space-y-3">
      <p className="text-xs text-slate-500">
        For each stop execution, the realized exit vs. the stop you declared — positive means the exit landed beyond the
        stop (gap-through or spread), costing more than the planned 1R. This is the cost backtests model as zero.
      </p>
      {d.inferred > 0 && (
        <p className="text-[11px] text-amber-400/90">
          {d.recorded} of {d.trades} stop execution(s) carry a recorded exit reason; {d.inferred} are inferred from a
          reasonless exit at/beyond the declared stop (mostly rows that predate exit-reason tracking).
        </p>
      )}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
        <StatTile
          label="Total overrun"
          value={fmtSignedUsd(d.totalUsd)}
          valueClass={costClass(d.totalUsd)}
          sub={d.totalUsd > 0 ? 'beyond plan' : d.totalUsd < 0 ? 'better than plan' : undefined}
        />
        <StatTile
          label="Beyond the stop"
          value={d.beyondPct == null ? '—' : `${fmtNum(d.beyondPct, 0)}%`}
          sub={`${d.beyondCount} of ${d.trades}`}
        />
        <StatTile
          label="Avg extra loss"
          value={r(d.avgOverrunR)}
          valueClass={d.avgOverrunR != null && d.avgOverrunR > 0 ? 'text-bear' : 'text-bull'}
          sub="per stop, in R"
        />
        <StatTile
          label="Median overrun"
          value={d.medianOverrunPct == null ? '—' : fmtPct(d.medianOverrunPct)}
          valueClass={d.medianOverrunPct == null ? '' : costClass(d.medianOverrunPct)}
        />
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-[11px] uppercase tracking-wide text-slate-500 border-b border-ink-600/60">
              <th className="py-1 pr-2 font-medium">Entry price</th>
              <th className="py-1 px-2 font-medium text-right">Stops</th>
              <th className="py-1 px-2 font-medium text-right">Beyond %</th>
              <th className="py-1 px-2 font-medium text-right">Avg extra R</th>
              <th className="py-1 pl-2 font-medium text-right">Total $</th>
            </tr>
          </thead>
          <tbody>
            {d.bands
              .filter((b) => b.trades > 0)
              .map((b) => (
                <tr key={b.label} className="border-b border-ink-700/40 last:border-0">
                  <td className="py-1 pr-2 font-medium text-slate-200">{b.label}</td>
                  <td className="py-1 px-2 text-right tabular-nums text-slate-400">{b.trades}</td>
                  <td className="py-1 px-2 text-right tabular-nums text-slate-400">
                    {b.beyondPct == null ? '—' : `${fmtNum(b.beyondPct, 0)}%`}
                  </td>
                  <td
                    className={cx(
                      'py-1 px-2 text-right tabular-nums',
                      b.avgOverrunR != null && b.avgOverrunR > 0 ? 'text-bear' : 'text-bull',
                    )}
                  >
                    {r(b.avgOverrunR)}
                  </td>
                  <td className={cx('py-1 pl-2 text-right tabular-nums', costClass(b.totalUsd))}>
                    {fmtSignedUsd(b.totalUsd)}
                  </td>
                </tr>
              ))}
          </tbody>
        </table>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-[11px] uppercase tracking-wide text-slate-500 border-b border-ink-600/60">
              <th className="py-1 pr-2 font-medium">Symbol</th>
              <th className="py-1 px-2 font-medium">Date</th>
              <th className="py-1 px-2 font-medium text-right">Stop</th>
              <th className="py-1 px-2 font-medium text-right">Exit</th>
              <th className="py-1 px-2 font-medium text-right">Extra R</th>
              <th className="py-1 pl-2 font-medium text-right">$</th>
            </tr>
          </thead>
          <tbody>
            {d.rows.map((row, i) => (
              <tr key={`${row.positionId}-${i}`} className="border-b border-ink-700/40 last:border-0">
                <td className="py-1 pr-2 font-medium text-slate-200">
                  {row.symbol} <span className="text-[11px] text-slate-500">{row.side}</span>
                  {row.basis === 'inferred' && <span className="text-[11px] text-amber-400/80"> · inferred</span>}
                </td>
                <td className="py-1 px-2 text-slate-400 text-xs">{row.date ? fmtDate(row.date) : '—'}</td>
                <td className="py-1 px-2 text-right tabular-nums text-slate-400">{fmtUsd(row.stopPrice)}</td>
                <td className="py-1 px-2 text-right tabular-nums text-slate-200">{fmtUsd(row.exitPrice)}</td>
                <td
                  className={cx(
                    'py-1 px-2 text-right tabular-nums',
                    row.overrunR != null && row.overrunR > 0 ? 'text-bear' : 'text-bull',
                  )}
                >
                  {r(row.overrunR)}
                </td>
                <td className={cx('py-1 pl-2 text-right tabular-nums', costClass(row.totalUsd))}>
                  {fmtSignedUsd(row.totalUsd)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="text-[11px] text-slate-500">
        Sorted most costly first. A high beyond-% concentrated in cheap tickers is the micro-cap tax — gap-throughs and
        wide spreads the price/volume floors exist to avoid. Add the avg extra R to your backtested per-trade edge to
        sanity-check whether it survives real fills.
      </p>
    </div>
  );
}

/** Monte-Carlo "will my sizing survive?" tool. Inputs default from your realized
 *  edge; it simulates many trade sequences at a fixed risk-% and reports how
 *  often you'd breach a drawdown threshold. Survival math — not a prediction. */
function RuinPanel({ active }: { active: boolean }) {
  const [winRate, setWinRate] = useState<number | undefined>(50);
  const [payoffRatio, setPayoffRatio] = useState<number | undefined>(1.5);
  const [riskPct, setRiskPct] = useState<number | undefined>(1);
  const [ruinThresholdPct, setRuinThresholdPct] = useState<number | undefined>(50);
  const [trades, setTrades] = useState<number | undefined>(100);
  const [result, setResult] = useState<RuinResult>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [seeded, setSeeded] = useState(false);

  useEffect(() => {
    if (!active || seeded) return;
    setSeeded(true);
    client
      .journalStats()
      .then((s) => {
        if (s.winRate) setWinRate(s.winRate);
        if (s.kelly) {
          setPayoffRatio(s.kelly.payoffRatio);
          if (s.kelly.suggestedRiskPct > 0) setRiskPct(s.kelly.suggestedRiskPct);
        }
      })
      .catch(() => {});
  }, [active, seeded]);

  const run = async () => {
    setBusy(true);
    setError(undefined);
    try {
      const r2 = await client.riskOfRuin({ winRate, payoffRatio, riskPct, ruinThresholdPct, trades });
      setResult(r2.result);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const ror = result?.riskOfRuinPct ?? 0;
  const rorClass = ror >= 25 ? 'text-bear' : ror >= 5 ? 'text-amber-400' : 'text-bull';

  return (
    <div className="space-y-3">
      <p className="text-xs text-slate-500">
        Defaults come from your realized stats. Simulates {fmtNum(5000, 0)} sequences of fixed-fractional bets and
        reports how often equity falls past the drawdown threshold. Assumes the edge holds and trades are independent.
      </p>
      <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
        <Field label="Win rate %">
          <NumberInput value={winRate} onChange={setWinRate} step={1} />
        </Field>
        <Field label="Payoff ratio" hint="avg win ÷ avg loss">
          <NumberInput value={payoffRatio} onChange={setPayoffRatio} step={0.1} />
        </Field>
        <Field label="Risk % / trade">
          <NumberInput value={riskPct} onChange={setRiskPct} step={0.1} />
        </Field>
        <Field label="Ruin = drawdown %">
          <NumberInput value={ruinThresholdPct} onChange={setRuinThresholdPct} step={5} />
        </Field>
        <Field label="Trades">
          <NumberInput value={trades} onChange={setTrades} step={10} />
        </Field>
      </div>
      <div className="flex justify-end">
        <button className="btn-primary" onClick={run} disabled={busy}>
          {busy ? 'Simulating…' : 'Simulate'}
        </button>
      </div>

      {error && <div className="text-bear text-sm">{error}</div>}

      {result && (
        <div className="space-y-3">
          <div className="text-center py-2">
            <div className="text-[11px] uppercase tracking-wide text-slate-500">
              Risk of losing {fmtNum(ruinThresholdPct ?? 50, 0)}% of the account
            </div>
            <div className={cx('text-3xl font-semibold tabular-nums', rorClass)}>{fmtNum(ror, 1)}%</div>
          </div>
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
            <StatTile label={`Median return (${trades} trades)`} value={fmtPct(result.medianReturnPct)} />
            <StatTile
              label="Outcome band (P5–P95)"
              value={`${fmtPct(result.p5ReturnPct)} … ${fmtPct(result.p95ReturnPct)}`}
            />
            <StatTile label="Median max drawdown" value={`${fmtNum(result.medianMaxDrawdownPct, 0)}%`} />
          </div>
          <p className="text-[11px] text-slate-500">
            Rule of thumb: keep risk-of-ruin near zero. If it’s high, cut your risk-% or improve the edge before sizing
            up.
          </p>
        </div>
      )}
    </div>
  );
}
