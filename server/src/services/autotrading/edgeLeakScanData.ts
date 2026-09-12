import { listPositions, Position } from '../../db/positions';
import { realizedPnlOf } from '../pnl';
import { listLiveOptionsPositions, liveOptionsPnl, LiveOptionsPosition } from '../../db/autotradeLiveOptionsPositions';
import { listPaperPositions, paperRealizedPnl, PaperPosition } from '../../db/autotradePaperPositions';
import { listOptionsPaperPositions, OptionsPaperPosition } from '../../db/autotradeOptionsPaperPositions';
import { optionsPaperRealizedPnl } from './optionsExecute';
import { getAutotradeConfig, AutotradeConfig } from '../../db/autotradeConfig';
import { listAutotradeEvents } from '../../db/autotradeEvents';
import { etDateTimeToMs, etToday } from '../../util/marketDate';
import { previousTradingSession } from '../trading/marketCalendar';
import { buildSectorOf } from './riskCheck';
import { collectBook, CollectedBook, DEFAULT_LOOKBACK_SESSIONS } from './dailyTargetSweepData';
import { goalInR } from './dailyTargetSweep';
import { deriveDollarCaps, DOLLAR_CAP_KEYS, handEditedDollarCaps } from './targetTune';
import { buildLiveSlippageRows } from './autoTune';
import {
  CollectedLeakBook,
  EdgeLeakScanResult,
  ExecutionOccurrence,
  JournalSkip,
  LeakBook,
  LeakTrade,
  runEdgeLeakScan,
  ScanFinding,
} from './edgeLeakScan';

// ---------------------------------------------------------------------------
// The DB half of the edge-leak scan: turn both books' closed positions into
// enriched LeakTrades, count the execution journal, read the configuration,
// and hand the lot to the pure scanner.
//
// ONE R BASIS, ALWAYS. The R of every trade is taken from `collectBook` —
// the exact collector the daily-target sweep and the dashboard's goal evidence
// already share — and joined onto the enriched attributes BY THE COLLECTOR'S
// OWN ID (`pos:12`, `lopt:3`, `paper:7`, `popt:4`). Nothing here recomputes a
// realized R, because the moment two modules derive the same quantity they
// start disagreeing (CLAUDE.md). A trade the collector dropped is dropped here
// too, and counted in `coverage`.
//
// NO MARKET DATA. Everything below reads SQLite: positions, the two paper
// tables, the live options table, the journal, the universe's sector column
// and the config row. The scan therefore costs nothing but CPU and can be run
// from a route or the daily routine without touching a provider quota.
// ---------------------------------------------------------------------------

/** The window the execution findings are counted over. Ten sessions, not the
 *  full forty: an execution defect is about the code running NOW, and a
 *  failure class that was fixed three weeks ago would otherwise be reported
 *  forever as an open finding. */
export const EXECUTION_LOOKBACK_SESSIONS = 10;

/** Execution classes worth a finding on ANY occurrence, with the plain-English
 *  label a report shows. These are things that went wrong, not distributions
 *  that read badly — one is already too many.
 *
 *  The list is the answer to "what would have caught the HOOD day": an exit
 *  decided and never filled shows up as `live_options_exit_failed` plus a
 *  position still open after its expiration, and both are here. */
export const EXECUTION_ACTIONS: {
  action: string;
  label: string;
  /** A `detail` key whose value splits this action into separate findings,
   *  for an action that carries more than one severity. */
  splitOn?: string;
  labelFor?: Record<string, string>;
}[] = [
  { action: 'live_options_exit_failed', label: 'An options exit could not be placed' },
  { action: 'live_options_stale_exit_unjudgeable', label: 'An options exit could not be priced' },
  {
    action: 'live_options_exit_reprice_deferred',
    label: 'An options exit re-price was deferred',
    // Two different events share this action and they are NOT equally bad:
    // `mid_fill` is the chase correctly standing aside while a partial fill is
    // in flight, and `daily_cap` is the chase having given up after its 20
    // re-prices with the order still resting -- which is the HOOD failure mode
    // recurring. Reported under one label they read identically, so a benign
    // partial fill would cry wolf every time and the real one would hide
    // behind it.
    splitOn: 'reason',
    labelFor: {
      mid_fill: 'An options exit re-price stood aside for a partial fill (benign)',
      daily_cap: 'An options exit exhausted its re-price budget and is still resting',
    },
  },
  { action: 'live_options_expired_worthless', label: 'An options position expired worthless' },
  { action: 'live_time_exit_failed', label: 'A timed stock exit failed' },
  { action: 'live_time_exit_blocked', label: 'A timed stock exit was blocked by a guardrail' },
  { action: 'live_position_unprotected', label: 'A live position had no resting stop' },
  { action: 'live_bracket_rearmed', label: 'A missing protective bracket had to be re-armed' },
  { action: 'live_stop_adjust_blocked', label: 'A stop ratchet could not find its resting leg' },
  { action: 'live_scale_out_blocked', label: 'A scale-out was refused by the broker' },
  { action: 'live_order_unknown_outcome', label: 'An order ended with an unknown outcome' },
  { action: 'daily_drawdown_halt', label: 'The daily drawdown halt tripped' },
  { action: 'give_back_halt', label: 'The give-back guard halted the day' },
];

/** The two rows that record the tuner's SWITCH rather than a tuner RUN. They
 *  share the `auto_tune_` prefix, so the violation count below must exclude
 *  them or turning the tuner off would report itself as the tuner misbehaving. */
export const TUNER_TRANSITION_ACTIONS = ['auto_tune_disabled', 'auto_tune_enabled'];

/**
 * When the continuous tuner was last switched OFF, or null if the journal does
 * not say.
 *
 * The finding this feeds asks "did the tuner write while it was meant to be
 * off", and that question has no answer without a moment to measure from. The
 * config row cannot supply one: `updated_at` moves on every loop tick, because
 * the equity sync writes `accountEquityUsd` every minute. So the moment is
 * journaled explicitly by the config route when the flag flips.
 *
 * Null is the honest answer for a flag that flipped before that row existed
 * (2026-09-12 is one such day) — the caller falls back to "today only", which
 * is the narrowest window that still has teeth: the tuner runs once per ET day
 * at 00:00, so a tuner that really is writing while disabled shows up on the
 * next day's scan rather than never.
 */
export function tunerDisabledAt(now: number): number | null {
  const since = now - 30 * 24 * 60 * 60 * 1000;
  const rows = listAutotradeEvents({ stage: 'config', actions: ['auto_tune_disabled'], since, limit: 10 });
  // listAutotradeEvents orders newest first.
  return rows.length ? rows[0].createdAt : null;
}

/** Live-book skips that explain why a paper entry had no live twin. */
const SKIP_ACTIONS = [
  'live_score_floor_skipped',
  'symbol_reentry_cooldown_skipped',
  'symbol_cooldown_skipped',
  'live_risk_blocked',
  'live_short_skipped',
  'live_entry_cutoff_skipped',
  'finish_line_skipped',
];

const isAutotradePosition = (p: Position): boolean => p.tags.includes('autotrade');

/** ET minutes past midnight, or null when the moment cannot be placed on the
 *  ET clock at all. */
function etMinuteOf(at: number): number | null {
  const d = new Date(at);
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(d);
  const hour = Number(parts.find((p) => p.type === 'hour')?.value);
  const minute = Number(parts.find((p) => p.type === 'minute')?.value);
  if (!Number.isFinite(hour) || !Number.isFinite(minute)) return null;
  return (hour % 24) * 60 + minute;
}

function weekdayOf(etDate: string): number {
  // Noon ET, so neither DST edge can push the date onto its neighbour.
  const at = etDateTimeToMs(etDate, '12:00');
  return at === null ? 0 : new Date(at).getUTCDay();
}

/** The `entry_extension_shadow` rows, keyed by symbol and minute, so a live
 *  entry can be joined to what the shadow gate saw at the moment it was
 *  placed. The shadow is journaled immediately after the placement call, so
 *  the two land in the same minute. */
export interface ExtensionRow {
  vwapExtPct: number | null;
  pctOfRange: number | null;
}

function extensionIndex(since: number): Map<string, ExtensionRow> {
  const out = new Map<string, ExtensionRow>();
  for (const e of listAutotradeEvents({ actions: ['entry_extension_shadow'], since, limit: 1000 })) {
    if (!e.symbol || !e.detail) continue;
    let parsed: { vwapExtPct?: unknown; pctOfRange?: unknown };
    try {
      parsed = JSON.parse(e.detail) as typeof parsed;
    } catch {
      continue;
    }
    const minute = etMinuteOf(e.createdAt);
    if (minute === null) continue;
    out.set(`${e.symbol}|${etToday(e.createdAt)}|${minute}`, {
      vwapExtPct: typeof parsed.vwapExtPct === 'number' ? parsed.vwapExtPct : null,
      pctOfRange: typeof parsed.pctOfRange === 'number' ? parsed.pctOfRange : null,
    });
  }
  return out;
}

/** Attributes for one collector id, before the round number is assigned. */
type PartialLeakTrade = Omit<LeakTrade, 'round' | 'r' | 'entryAt' | 'exitAt'>;

function attributesForLiveBook(
  closed: Position[],
  liveOptionsClosed: LiveOptionsPosition[],
  sectorOf: (symbol: string) => string | null,
  extensions: Map<string, ExtensionRow>,
): Map<string, PartialLeakTrade> {
  const out = new Map<string, PartialLeakTrade>();
  for (const p of closed) {
    if (!isAutotradePosition(p) || p.status !== 'closed' || p.exits.length === 0) continue;
    const last = p.exits.reduce((a, b) => (b.createdAt > a.createdAt ? b : a));
    const entryAt = p.entryTime && p.entryDate ? etDateTimeToMs(p.entryDate, p.entryTime) : p.createdAt;
    const minute = entryAt === null ? null : etMinuteOf(entryAt);
    const etDate = p.entryDate ?? etToday(p.createdAt);
    const ext = minute === null ? undefined : extensions.get(`${p.symbol}|${etDate}|${minute}`);
    out.set(`pos:${p.id}`, {
      id: `pos:${p.id}`,
      book: 'live',
      symbol: p.symbol,
      sector: sectorOf(p.symbol),
      assetKind: 'equity',
      etDate,
      entryMinuteEt: minute,
      pnlUsd: realizedPnlOf(p),
      score: p.entryScore,
      exitReason: last.exitReason,
      holdMinutes: entryAt === null ? 0 : Math.max(0, Math.round((last.createdAt - entryAt) / 60_000)),
      quantity: p.quantity,
      mlRegime: p.mlRegime,
      weekday: weekdayOf(etDate),
      vwapExtPct: ext?.vwapExtPct ?? null,
      pctOfRange: ext?.pctOfRange ?? null,
    });
  }
  for (const p of liveOptionsClosed) {
    if (p.status !== 'closed' || p.exitPrice === null || p.exitAt === null) continue;
    const etDate = etToday(p.entryAt);
    out.set(`lopt:${p.id}`, {
      id: `lopt:${p.id}`,
      book: 'live',
      symbol: p.symbol,
      sector: sectorOf(p.symbol),
      assetKind: 'options',
      etDate,
      entryMinuteEt: etMinuteOf(p.entryAt),
      pnlUsd: liveOptionsPnl(p, p.exitPrice),
      score: p.entryScore,
      exitReason: p.exitReason,
      holdMinutes: Math.max(0, Math.round((p.exitAt - p.entryAt) / 60_000)),
      quantity: p.quantity,
      mlRegime: p.mlRegime,
      weekday: weekdayOf(etDate),
      // The extension shadow is journaled on the EQUITY entry path only; an
      // options entry genuinely has no reading, which is why it is null rather
      // than an "unknown" bucket the dimension would then average.
      vwapExtPct: null,
      pctOfRange: null,
    });
  }
  return out;
}

function attributesForPaperBook(
  paper: PaperPosition[],
  optionsPaper: OptionsPaperPosition[],
  sectorOf: (symbol: string) => string | null,
): Map<string, PartialLeakTrade> {
  const out = new Map<string, PartialLeakTrade>();
  for (const p of paper) {
    if (p.status !== 'closed' || p.exitAt === null) continue;
    const etDate = etToday(p.entryAt);
    out.set(`paper:${p.id}`, {
      id: `paper:${p.id}`,
      book: 'paper',
      symbol: p.symbol,
      sector: sectorOf(p.symbol),
      assetKind: 'equity',
      etDate,
      entryMinuteEt: etMinuteOf(p.entryAt),
      pnlUsd: paperRealizedPnl(p),
      score: p.entryScore,
      exitReason: p.exitReason,
      holdMinutes: Math.max(0, Math.round((p.exitAt - p.entryAt) / 60_000)),
      quantity: p.quantity,
      mlRegime: p.mlRegime,
      weekday: weekdayOf(etDate),
      vwapExtPct: null,
      pctOfRange: null,
    });
  }
  for (const p of optionsPaper) {
    if (p.status !== 'closed' || p.exitAt === null || p.exitPrice === null) continue;
    const etDate = etToday(p.entryAt);
    out.set(`popt:${p.id}`, {
      id: `popt:${p.id}`,
      book: 'paper',
      symbol: p.symbol,
      sector: sectorOf(p.symbol),
      assetKind: 'options',
      etDate,
      entryMinuteEt: etMinuteOf(p.entryAt),
      pnlUsd: optionsPaperRealizedPnl(p),
      score: null,
      exitReason: p.exitReason,
      holdMinutes: Math.max(0, Math.round((p.exitAt - p.entryAt) / 60_000)),
      quantity: p.quantity,
      mlRegime: p.mlRegime,
      weekday: weekdayOf(etDate),
      vwapExtPct: null,
      pctOfRange: null,
    });
  }
  return out;
}

/**
 * Join the collector's trades to their attributes and number the rounds.
 *
 * ROUND is assigned here rather than at the source because it is a property of
 * the SESSION, not of the row: the nth entry on a symbol on an ET date, by
 * entry time. That is the cut the record says carries the leak (round 1 +$342,
 * round 2 −$185 on the live book), and it cannot be read off any single
 * position.
 */
export function joinLeakTrades(collected: CollectedBook, attributes: Map<string, PartialLeakTrade>): CollectedLeakBook {
  const trades: LeakTrade[] = [];
  let dropped = collected.droppedTrades;
  for (const t of collected.trades) {
    const attrs = attributes.get(t.id);
    if (!attrs) {
      dropped += 1;
      continue;
    }
    trades.push({ ...attrs, entryAt: t.entryAt, exitAt: t.exitAt, r: t.r, round: 0 });
  }
  const bySymbolDay = new Map<string, LeakTrade[]>();
  for (const t of trades) {
    const key = `${t.symbol}|${t.etDate}`;
    const hit = bySymbolDay.get(key);
    if (hit) hit.push(t);
    else bySymbolDay.set(key, [t]);
  }
  for (const rows of bySymbolDay.values()) {
    rows.sort((a, b) => a.entryAt - b.entryAt);
    rows.forEach((t, i) => (t.round = i + 1));
  }
  return { trades, sessionDates: collected.sessionDates, droppedTrades: dropped };
}

/** Execution occurrences over the last EXECUTION_LOOKBACK_SESSIONS sessions. */
export function collectExecutionFindings(now: number): ExecutionOccurrence[] {
  let date = etToday(now);
  for (let i = 0; i < EXECUTION_LOOKBACK_SESSIONS; i++) date = previousTradingSession(date);
  const since = etDateTimeToMs(date, '00:00') ?? now - EXECUTION_LOOKBACK_SESSIONS * 24 * 60 * 60 * 1000;
  const counts = new Map<string, number>();
  for (const e of listAutotradeEvents({
    actions: EXECUTION_ACTIONS.map((a) => a.action),
    since,
    limit: 1000,
  })) {
    const spec = EXECUTION_ACTIONS.find((a) => a.action === e.action);
    let key = e.action;
    if (spec?.splitOn !== undefined) {
      // An unparseable or absent detail falls back to the unsplit action
      // rather than being dropped: an occurrence we cannot classify is still
      // an occurrence, and silently losing it is the worse failure.
      const variant = detailValue(e.detail, spec.splitOn);
      if (variant !== null && spec.labelFor?.[variant] !== undefined) key = `${e.action}|${variant}`;
    }
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const out: ExecutionOccurrence[] = [];
  for (const a of EXECUTION_ACTIONS) {
    const variants =
      a.labelFor === undefined
        ? []
        : Object.keys(a.labelFor).map((v) => ({ key: `${a.action}|${v}`, label: a.labelFor![v] }));
    for (const { key, label } of [...variants, { key: a.action, label: a.label }]) {
      const n = counts.get(key) ?? 0;
      if (n === 0) continue;
      out.push({
        action: key,
        count: n,
        detail: `${label} — ${n} in the last ${EXECUTION_LOOKBACK_SESSIONS} sessions`,
      });
    }
  }
  return out;
}

/** One key out of a journal row's JSON `detail`, or null when it is absent or
 *  the detail does not parse. */
function detailValue(detail: string | null, key: string): string | null {
  if (detail === null) return null;
  try {
    const parsed: unknown = JSON.parse(detail);
    if (typeof parsed !== 'object' || parsed === null) return null;
    const v = (parsed as Record<string, unknown>)[key];
    return typeof v === 'string' ? v : null;
  } catch {
    return null;
  }
}

/**
 * The configuration findings: a cap that no longer matches its derivation, a
 * tuner row on a book whose tuner is meant to be off, and an equity reading the
 * caps refused to follow.
 *
 * The frozen-cap test comes from `handEditedDollarCaps` — the same function the
 * re-anchor consults — rather than a second comparison, so the scan and the
 * re-anchor can never disagree about which caps are the operator's.
 */
export function collectConfigurationFindings(cfg: AutotradeConfig, now: number): ScanFinding[] {
  const out: ScanFinding[] = [];
  const anchor = cfg.liveCapsAnchorEquityUsd;
  const frozen = handEditedDollarCaps(cfg);
  if (anchor !== null && anchor > 0 && frozen.length > 0) {
    const derived = deriveDollarCaps(cfg, anchor);
    for (const key of DOLLAR_CAP_KEYS) {
      if (!frozen.includes(key)) continue;
      out.push({
        id: `configuration:frozen:${key}`,
        kind: 'configuration',
        label: `${key} is frozen out of re-anchoring`,
        count: 1,
        detail: `stored $${cfg[key]} vs $${derived[key]} derived at the $${Math.round(anchor)} anchor — set it to the derived value to hand it back to the automatic re-anchor`,
        lever: {
          kind: 'config',
          field: key,
          value: derived[key],
          direction: 'safe',
          detail: 'Storing the derived value makes the cap anchor-owned again, so it follows equity from here on.',
        },
      });
    }
  }

  const since = now - 7 * 24 * 60 * 60 * 1000;
  const tuner = listAutotradeEvents({ stage: 'config', since, limit: 200 }).filter(
    (e) => e.action.startsWith('auto_tune_') && !TUNER_TRANSITION_ACTIONS.includes(e.action),
  );
  const tunerSince = tunerDisabledAt(now) ?? etDateTimeToMs(etToday(now), '00:00') ?? now;
  const offending = tuner.filter((e) => e.createdAt >= tunerSince);
  if (!cfg.autoTuneEnabled && offending.length > 0) {
    out.push({
      id: 'configuration:auto_tune_ran',
      kind: 'configuration',
      label: 'The continuous tuner wrote while it was meant to be off',
      count: offending.length,
      detail: `${offending.length} auto_tune_* row(s) since the tuner was switched off — the trial's sizing is not the sizing that was agreed`,
      lever: {
        kind: 'config',
        field: 'autoTuneEnabled',
        value: false,
        direction: 'safe',
        detail: 'Confirm the tuner is off; a row with it off means something else is writing the risk %.',
      },
    });
  }

  const suspect = listAutotradeEvents({ stage: 'config', actions: ['equity_read_suspect'], since, limit: 50 });
  if (suspect.length > 0) {
    out.push({
      id: 'configuration:equity_read_suspect',
      kind: 'configuration',
      label: 'An equity reading was too far below the anchor to trust',
      count: suspect.length,
      detail: `${suspect.length} session(s) in the last 7 days held the dollar caps rather than re-anchoring down — check for a deposit, a withdrawal or manual trading`,
      lever: {
        kind: 'config',
        field: 'liveCapsAnchorEquityUsd',
        value: null,
        direction: 'safe',
        detail:
          'If the lower equity is real, set the anchor to it; otherwise nothing to do — the hold expires on its own.',
      },
    });
  }
  return out;
}

/** Live-book skips within the window, for the attribution's untaken classes. */
function collectJournalSkips(since: number): JournalSkip[] {
  return listAutotradeEvents({ actions: SKIP_ACTIONS, since, limit: 1000 })
    .filter((e) => e.symbol !== null)
    .map((e) => {
      let failedRule: string | null = null;
      if (e.detail) {
        try {
          const parsed = JSON.parse(e.detail) as { failedRules?: unknown };
          if (Array.isArray(parsed.failedRules) && typeof parsed.failedRules[0] === 'string') {
            failedRule = parsed.failedRules[0];
          }
        } catch {
          failedRule = null;
        }
      }
      return { symbol: e.symbol as string, at: e.createdAt, action: e.action, failedRule };
    });
}

/** The stored daily goal expressed in R at the stored risk % — the level the
 *  goal-rate is counted at. Null when no goal is armed or risk is 0, because
 *  "how often did we reach nothing" is not a question. */
export function storedTargetRFor(cfg: AutotradeConfig): number | null {
  return goalInR(cfg.targetDailyGainPct, cfg.riskPerTradePct);
}

export interface EdgeLeakScanOptions {
  lookbackSessions?: number;
  books?: LeakBook[];
  now?: number;
}

/** The one call a route or the routine makes. */
export function runEdgeLeakScanFromDb(opts: EdgeLeakScanOptions = {}): EdgeLeakScanResult {
  const now = opts.now ?? Date.now();
  const lookbackSessions = opts.lookbackSessions ?? DEFAULT_LOOKBACK_SESSIONS;
  const books = opts.books ?? ['live', 'paper'];
  const cfg = getAutotradeConfig();
  const sectorOf = buildSectorOf();

  const liveCollected = collectBook('live', lookbackSessions, now);
  const paperCollected = collectBook('paper', lookbackSessions, now);
  const windowStart = liveCollected.sessionDates.length
    ? (etDateTimeToMs(liveCollected.sessionDates[0], '00:00') ?? now - lookbackSessions * 86_400_000)
    : now - lookbackSessions * 86_400_000;

  const live = joinLeakTrades(
    liveCollected,
    attributesForLiveBook(
      listPositions({ status: 'closed' }),
      listLiveOptionsPositions({ status: 'closed' }),
      sectorOf,
      extensionIndex(windowStart),
    ),
  );
  const paper = joinLeakTrades(
    paperCollected,
    attributesForPaperBook(
      listPaperPositions({ status: 'closed' }),
      listOptionsPaperPositions({ status: 'closed' }),
      sectorOf,
    ),
  );

  // Entry slippage over the window, in % of the limit price. Entries only: an
  // exit's slippage is the chase doing its job, and pooling the two would hide
  // the number the attribution is actually about.
  const entrySlippagePct = buildLiveSlippageRows()
    .filter((r) => r.kind === 'entry' && r.date >= (liveCollected.sessionDates[0] ?? '0000-00-00'))
    .map((r) => r.pct);

  return runEdgeLeakScan({
    books,
    live: books.includes('live') ? live : { trades: [], sessionDates: live.sessionDates, droppedTrades: 0 },
    paper: books.includes('paper') ? paper : { trades: [], sessionDates: paper.sessionDates, droppedTrades: 0 },
    lookbackSessions,
    storedTargetR: storedTargetRFor(cfg),
    execution: collectExecutionFindings(now),
    configuration: collectConfigurationFindings(cfg, now),
    entrySlippagePct,
    journalSkips: collectJournalSkips(windowStart),
    asOf: now,
  });
}
