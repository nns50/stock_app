import { listPositions, Position } from '../../db/positions';
import { getIntents } from '../../db/orders';
import { getProvider } from '../../providers';
import { computeSlippage, groupSlippageBySymbol, SlippageRow } from '../slippage';
import { computeJournalStats, realizedPnlOf } from '../pnl';
import { aggregateExcursions, computeExcursion, ExcursionReport, TradeExcursion } from '../excursion';
import { computeExcursionTune } from './excursionTune';
import { checkOosEdgeConfirmation } from './significance';
import { getAutotradeConfig, setAutotradeConfig } from '../../db/autotradeConfig';
import { addExclusion, isExcluded } from '../../db/autotradeExclusions';
import { listAutotradeEvents, logAutotradeEvent } from '../../db/autotradeEvents';
import { dispatchNotifications } from '../notifier';

// ---------------------------------------------------------------------------
// Auto-tune from realized edge (2026-07-18 follow-up to the Journal page's
// pre-existing analytics — see AutotradeConfig.autoTuneEnabled's own doc
// comment for the full design). Off unless explicitly enabled; runs at most
// once per (ET) trading day, gated the same "journal a marker, check for it
// next time" way dailyHaltAlert.ts's own once-per-day throttle is, so it
// survives a restart without needing a separate persisted timestamp.
// ---------------------------------------------------------------------------

/** Today's date (YYYY-MM-DD) in US/Eastern — same "trading day" convention
 *  riskCheck.ts's own etDateStr() uses, duplicated here for the same reason
 *  dailyHaltAlert.ts's copy gives (avoids a circular import). */
function etDateStr(ms: number = Date.now()): string {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(ms);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
  return `${get('year')}-${get('month')}-${get('day')}`;
}

const RAN_ACTION = 'auto_tune_ran';
interface RanMarkerDetail {
  date: string;
}

function alreadyRanToday(today: string): boolean {
  return listAutotradeEvents({ stage: 'config', actions: [RAN_ACTION], limit: 10 }).some((e) => {
    if (!e.detail) return false;
    try {
      return (JSON.parse(e.detail) as RanMarkerDetail).date === today;
    } catch {
      return false;
    }
  });
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/** Every live-traded fill (entry or exit) that traces back to an order with a
 *  persisted limit price — same scope and shape as routes/journal.ts's own
 *  '/slippage' route, batching the order_intents lookup (getIntents) instead
 *  of that route's one-by-one getIntent() calls, since this walks the WHOLE
 *  journal rather than serving a single on-demand request. */
function buildSlippageRows(): SlippageRow[] {
  const positions = listPositions();
  const ids = new Set<number>();
  for (const p of positions) {
    if (p.sourceIntentId != null) ids.add(p.sourceIntentId);
    for (const e of p.exits) if (e.sourceIntentId != null) ids.add(e.sourceIntentId);
  }
  const intents = getIntents(Array.from(ids));

  const rows: SlippageRow[] = [];
  for (const p of positions) {
    // Entry-side slippage is dated by the entry. A position with none is
    // skipped rather than labelled with a guess — in practice this excludes
    // nothing, since only Webull-IMPORTED lots can be undated and those have
    // no sourceIntentId to compare a fill against in the first place.
    if (p.sourceIntentId != null && p.entryDate !== null) {
      const entryDate = p.entryDate;
      const intent = intents.get(p.sourceIntentId);
      if (intent?.limitPrice != null) {
        rows.push(
          computeSlippage({
            positionId: p.id,
            symbol: p.symbol,
            kind: 'entry',
            side: intent.side,
            date: entryDate,
            limitPrice: intent.limitPrice,
            fillPrice: p.entryPrice,
            quantity: p.quantity,
            multiplier: p.multiplier,
          }),
        );
      }
    }
    for (const e of p.exits) {
      if (e.sourceIntentId == null) continue;
      const intent = intents.get(e.sourceIntentId);
      if (intent?.limitPrice == null) continue;
      rows.push(
        computeSlippage({
          positionId: p.id,
          symbol: p.symbol,
          kind: 'exit',
          side: intent.side,
          date: e.exitDate,
          limitPrice: intent.limitPrice,
          fillPrice: e.exitPrice,
          quantity: e.quantity,
          multiplier: p.multiplier,
        }),
      );
    }
  }
  return rows;
}

/** Autotrade's own closed trades — the tag every autotrade fill carries (live or
 *  paper-adopted), matching autoTuneEfficacy.ts's identical local predicate. */
function isAutotradePosition(p: Position): boolean {
  return p.tags.includes('autotrade');
}

/** The date a trade concluded: its last exit, else its entry (null when that
 *  is unknown too — such a trade has no place on a timeline). */
const lastExitDateOf = (p: Position): string | null =>
  p.exits.length
    ? p.exits
        .map((e) => e.exitDate)
        .sort()
        .slice(-1)[0]
    : p.entryDate;

// Bound the once-per-day candle fetch: most-recent closed autotrade stock trades
// are the ones whose excursion is relevant to today's exit geometry.
const EXCURSION_TUNE_MAX_TRADES = 100;

/** Build the MAE/MFE excursion report over closed autotrade stock trades — the
 *  same per-trade daily-candle fetch routes/journal.ts's '/excursions' does,
 *  scoped to autotrade's own fills. Best-effort per trade (a symbol whose
 *  candles can't be fetched is skipped, not fatal). */
async function buildAutotradeExcursionReport(): Promise<ExcursionReport> {
  // An excursion walks daily candles from the ENTRY to the exit, so a trade
  // with no known entry date cannot be measured at all. In practice this
  // excludes nothing: only Webull-IMPORTED lots can be undated, and those
  // carry no sourceIntentId, so isAutotradePosition already rejects them.
  const closed = listPositions({ status: 'closed', assetType: 'stock' })
    .filter(isAutotradePosition)
    .filter((p): p is typeof p & { entryDate: string } => p.entryDate !== null)
    .sort((a, b) => b.entryDate.localeCompare(a.entryDate))
    .slice(0, EXCURSION_TUNE_MAX_TRADES);
  const provider = getProvider();
  const rows: TradeExcursion[] = [];
  await Promise.all(
    closed.map(async (p) => {
      try {
        const candles = await provider.getCandles(p.symbol, 'daily', {
          start: p.entryDate,
          end: lastExitDateOf(p) ?? undefined,
        });
        const ex = computeExcursion(
          {
            positionId: p.id,
            symbol: p.symbol,
            side: p.side,
            entryPrice: p.entryPrice,
            quantity: p.quantity,
            multiplier: p.multiplier,
            stopPrice: p.stopPrice,
            realizedPnl: realizedPnlOf(p),
            entryDate: p.entryDate,
          },
          candles,
        );
        if (ex) rows.push(ex);
      } catch {
        // skip trades whose candles can't be fetched — best effort
      }
    }),
  );
  return aggregateExcursions(rows);
}

export interface AutoTuneResult {
  /** False when disabled or already run today — everything below is
   *  meaningless in that case. */
  ran: boolean;
  riskAdjusted: boolean;
  symbolsExcluded: string[];
  /** True when the exit-geometry tune changed stopAtrMultiple/targetRMultiple. */
  exitsAdjusted: boolean;
}

/**
 * Runs (at most once per ET trading day) when AutotradeConfig.autoTuneEnabled
 * is on:
 *  - Nudges riskPerTradePct toward the Journal page's own Kelly suggestion,
 *    once there are at least autoTuneMinTrades decisive closed trades,
 *    clamped to at most autoTuneMaxStepPct percentage points of change for
 *    the day.
 *  - Auto-excludes (db/autotradeExclusions.ts) any symbol whose average
 *    live-fill slippage is at or above autoTuneSlippageExcludePct over at
 *    least autoTuneMinTrades fills.
 * Every adjustment is journaled (autotrade_events) so it's visible on Recent
 * Activity. Best-effort — never throws; the caller (loop.ts) treats this the
 * same as every other post-tick best-effort check.
 */
export async function maybeAutoTune(now: number = Date.now()): Promise<AutoTuneResult> {
  const config = getAutotradeConfig();
  if (!config.autoTuneEnabled) return { ran: false, riskAdjusted: false, symbolsExcluded: [], exitsAdjusted: false };

  const today = etDateStr(now);
  if (alreadyRanToday(today)) return { ran: false, riskAdjusted: false, symbolsExcluded: [], exitsAdjusted: false };

  // Journal the marker BEFORE acting — same reasoning as dailyHaltAlert.ts's
  // own once-per-day throttle: the journal is the source of truth even if
  // this runs slowly and another tick starts concurrently.
  logAutotradeEvent({ stage: 'config', action: RAN_ACTION, detail: { date: today } satisfies RanMarkerDetail });

  let riskAdjusted = false;
  // The LOOP's own trades only — same predicate the excursion tuner below has
  // always used. This read ALL closed journal positions until 2026-08-21,
  // which let MANUAL trades (a different trader with a different exit
  // discipline — the operator's own diagnosis: winners held past their
  // targets out of psychology) drive the loop's Kelly suggestion and the
  // walk-forward guard's confirmed/unconfirmed verdict. Auto-tune sizes the
  // loop, so it must be judged on the loop's discipline, not the human's:
  // rule-based exits produce a different (low-win-rate, big-winner) return
  // shape than discretionary ones, and mixing the two biased both the target
  // and the confidence interval toward whichever trader traded more.
  const closedPositions = listPositions({ status: 'closed' }).filter(isAutotradePosition);
  const stats = computeJournalStats(closedPositions);
  if (stats.kelly && stats.kelly.sampleSize >= config.autoTuneMinTrades) {
    const target = stats.kelly.suggestedRiskPct;
    const current = config.riskPerTradePct;
    const delta = Math.max(-config.autoTuneMaxStepPct, Math.min(config.autoTuneMaxStepPct, target - current));
    const next = round2(Math.max(0, current + delta));
    if (Math.abs(next - current) > 1e-9) {
      // Walk-forward guard (2026-07-24): before RAISING risk, require the edge to
      // still hold out-of-sample — the in-sample edge the Kelly number is fit to
      // is already selected to look good. A DECREASE is always applied (the safe
      // direction). Same closed-trade population the Kelly suggestion is derived
      // from, oldest → newest.
      let oosBlocked = false;
      if (next > current && config.autoTuneRequireOosConfirmation) {
        const chrono = closedPositions
          .map((p) => ({ pnl: realizedPnlOf(p), date: lastExitDateOf(p) }))
          // Undated trades have no place on a chronological curve — dropped rather
          // than anchored to a guessed date (see db/positions.ts on why entryDate
          // can be null at all).
          .filter((t): t is { pnl: number; date: string } => t.date !== null)
          .sort((a, b) => a.date.localeCompare(b.date));
        const guard = checkOosEdgeConfirmation(chrono);
        if (!guard.confirmed) {
          oosBlocked = true;
          logAutotradeEvent({
            stage: 'config',
            action: 'auto_tune_risk_increase_blocked',
            detail: {
              from: current,
              wouldRaiseTo: next,
              kellySuggested: target,
              reason: guard.reason,
              oosSampleSize: guard.oosSampleSize,
              oosExpectancy: guard.oosExpectancy,
              oosCiLow: guard.oosCiLow,
            },
          });
        }
      }
      if (!oosBlocked) {
        setAutotradeConfig({ riskPerTradePct: next });
        logAutotradeEvent({
          stage: 'config',
          action: 'auto_tune_risk_adjusted',
          detail: { from: current, to: next, kellySuggested: target, sampleSize: stats.kelly.sampleSize },
        });
        // Same "push it, don't just journal it" treatment as the daily-drawdown
        // halt — a live risk-% change is consequential enough to surface
        // immediately, not just discoverable later on Recent Activity.
        await dispatchNotifications([
          {
            title: 'Autotrade auto-tune: risk-per-trade adjusted',
            message:
              `riskPerTradePct ${current}% → ${next}% (Kelly suggests ${target}% from ` +
              `${stats.kelly.sampleSize} decisive closed trades).`,
          },
        ]);
        riskAdjusted = true;
      }
    }
  }

  const symbolsExcluded: string[] = [];
  const bySymbol = groupSlippageBySymbol(buildSlippageRows());
  for (const g of bySymbol) {
    if (g.trades < config.autoTuneMinTrades) continue;
    if (g.avgPct < config.autoTuneSlippageExcludePct) continue;
    if (isExcluded(g.symbol)) continue;
    addExclusion(
      g.symbol,
      `Auto-excluded: avg slippage ${g.avgPct}% over ${g.trades} fill${g.trades === 1 ? '' : 's'} ` +
        `(>= ${config.autoTuneSlippageExcludePct}% threshold)`,
    );
    logAutotradeEvent({
      symbol: g.symbol,
      stage: 'config',
      action: 'auto_tune_symbol_excluded',
      detail: { avgPct: g.avgPct, trades: g.trades, thresholdPct: config.autoTuneSlippageExcludePct },
    });
    // Same reasoning as the risk-% adjustment above: worth a push, not just a
    // journal entry — the symbol stops being traded starting now.
    await dispatchNotifications([
      {
        title: `Autotrade auto-tune: ${g.symbol} excluded`,
        message:
          `Avg slippage ${g.avgPct}% over ${g.trades} fill${g.trades === 1 ? '' : 's'} ` +
          `(>= ${config.autoTuneSlippageExcludePct}% threshold) — added to the autotrade exclusion list ` +
          `(Settings → Autotrade exclusions to review or remove).`,
      },
    ]);
    symbolsExcluded.push(g.symbol);
  }

  // Exit-geometry tune (independent of the risk-% tune above; own flag). Nudge
  // stopAtrMultiple / targetRMultiple toward what winning autotrade trades'
  // MAE/MFE actually did, bounded by autoTuneExitMaxStep per run.
  let exitsAdjusted = false;
  if (config.autoTuneExitsEnabled) {
    const report = await buildAutotradeExcursionReport();
    const result = computeExcursionTune(
      report,
      { stopAtrMultiple: config.stopAtrMultiple, targetRMultiple: config.targetRMultiple },
      {
        minTrades: config.autoTuneMinTrades,
        maxStep: config.autoTuneExitMaxStep,
        // Ignore trades entered under the PREVIOUS geometry — excursion is
        // measured against each trade's own stop, so re-reading them would
        // re-apply a correction that has already been made.
        sampleSince: config.autoTuneExitTunedAt,
      },
    );
    if (result.patch.stopAtrMultiple !== undefined || result.patch.targetRMultiple !== undefined) {
      // Stamp the change so the next run only judges it on trades taken under it.
      setAutotradeConfig({ ...result.patch, autoTuneExitTunedAt: Date.now() });
      const nextStop = result.patch.stopAtrMultiple ?? config.stopAtrMultiple;
      const nextTarget = result.patch.targetRMultiple ?? config.targetRMultiple;
      logAutotradeEvent({
        stage: 'config',
        action: 'auto_tune_exits_adjusted',
        detail: {
          from: { stopAtrMultiple: config.stopAtrMultiple, targetRMultiple: config.targetRMultiple },
          to: { stopAtrMultiple: nextStop, targetRMultiple: nextTarget },
          winners: result.diagnostics.winners,
          avgWinnerHeatR: result.diagnostics.avgWinnerHeatR,
          avgWinnerMfeR: result.diagnostics.avgWinnerMfeR,
        },
      });
      await dispatchNotifications([
        {
          title: 'Autotrade auto-tune: exit geometry adjusted',
          message:
            `stop ${config.stopAtrMultiple}×ATR → ${nextStop}×ATR, ` +
            `target ${config.targetRMultiple}R → ${nextTarget}R ` +
            `(from ${result.diagnostics.winners} winning trades' MAE/MFE).`,
        },
      ]);
      exitsAdjusted = true;
    }
  }

  return { ran: true, riskAdjusted, symbolsExcluded, exitsAdjusted };
}
