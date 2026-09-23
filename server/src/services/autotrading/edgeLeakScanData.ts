import { listPositions, Position } from '../../db/positions';
import { realizedPnlOf } from '../pnl';
import { listLiveOptionsPositions, liveOptionsPnl, LiveOptionsPosition } from '../../db/autotradeLiveOptionsPositions';
import { listPaperPositions, paperRealizedPnl, PaperPosition } from '../../db/autotradePaperPositions';
import { listOptionsPaperPositions, OptionsPaperPosition } from '../../db/autotradeOptionsPaperPositions';
import { optionsPaperRealizedPnl } from './optionsExecute';
import { getAutotradeConfig, AutotradeConfig } from '../../db/autotradeConfig';
import { listAutotradeEvents, listAutotradeEventsInWindow } from '../../db/autotradeEvents';
import { etDateTimeToMs, etToday } from '../../util/marketDate';
import { previousTradingSession } from '../trading/marketCalendar';
import { buildSectorOf } from './riskCheck';
import { collectBook, CollectedBook, DEFAULT_LOOKBACK_SESSIONS } from './dailyTargetSweepData';
import { DropReasons, dropTotal, goalInR } from './dailyTargetSweep';
import {
  concentrationCapFloorPct,
  deriveDollarCaps,
  DOLLAR_CAP_KEYS,
  giveBackArmedByOneTrade,
  handEditedDollarCaps,
} from './targetTune';
import { maxAffordablePremiumPerShare, riskPctUpperBound } from './optionsAffordability';
import { getOptionsProbationStatus } from './liveOptionsExecute';
import { buildLiveSlippageRows } from './autoTune';
import { MARKETABLE_LIMIT_BUFFER_PCT } from './marketableLimit';
import { entryDriftPct } from './entryRisk';
import { getLastReentryShadowRecord } from '../../db/reentryShadowRecords';
import { reentryShadowEvidenceOf } from './reentryShadowRecordData';
import {
  BatchRefusal,
  CollectedLeakBook,
  EdgeLeakScanResult,
  equivalentPaceFloor,
  paceFloorDrift,
  ExecutionOccurrence,
  ExtensionQuality,
  JournalSkip,
  LeakBook,
  LeakTrade,
  mulberry32,
  reentryCooldownFinding,
  runEdgeLeakScan,
  SCAN_RNG_SEED,
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
  // The writers name these `…_order_outcome_unknown` (liveFailureAlert.ts's
  // AMBIGUITY_ACTIONS). Until 2026-09-23 this entry read
  // `live_order_unknown_outcome`, a name nothing writes, so an unknown outcome
  // could never become a finding. The reachability guard missed it because
  // this catalog's own `action:` keys counted as emits. See
  // journalActionsReachability.test.ts.
  { action: 'live_order_outcome_unknown', label: 'A stock order ended with an unknown outcome' },
  { action: 'live_options_order_outcome_unknown', label: 'An options order ended with an unknown outcome' },
  // An order the broker accepted that neither list nor a direct Order Detail
  // read can find (orderDetailFallback.ts): SHOP's 2026-09-22 state, which
  // held a filled close open in the ledger.
  {
    action: 'live_order_status_unresolved',
    label: 'A stock order the broker accepted could not be found by any read',
  },
  {
    action: 'live_options_order_status_unresolved',
    label: 'An options order the broker accepted could not be found by any read',
  },
  // A broker-sync estimate replaced by a real fill. Split by where the fill
  // came from, because the two are not the same kind of event:
  // `app_order` is the app's own close, which the positions read saw before
  // the order read did. The record is right afterwards, and the finding is
  // that the race happened at all. `broker_history` is a hand close in Webull
  // re-booked at the operator's own fill: not an app defect, but a trade the
  // strategy figure carries and the operator made.
  {
    action: 'live_options_exit_corrected',
    label: 'A confirmed options fill replaced a broker-sync estimate',
    splitOn: 'source',
    labelFor: {
      app_order: "The app's own options close was booked late: the order read lagged the positions read",
      broker_history: "A hand close in Webull was re-booked at the operator's fill",
    },
  },
  // The stock twin (2026-09-23), split the same way. `bracket_leg`: the
  // position sync priced a bracket exit at a quote before the entry's
  // reconcile could read the leg, a race the app lost, and the step-down, the
  // halt and the expectancy sizing all read the wrong number until corrected
  // (COIN, 2026-09-21: a -$3.22 stop booked as a +$105 'manual' win).
  // `broker_history`: a hand sale re-booked at the operator's fill.
  {
    action: 'live_exit_corrected',
    label: 'A stock exit the position sync priced at a quote was corrected to its fill',
    splitOn: 'source',
    labelFor: {
      bracket_leg: "A stock bracket exit was booked at a quote before the reconcile read the leg's fill",
      broker_history: "A stock the operator sold by hand in Webull was re-booked at the operator's fill",
    },
  },
  // Two RISK CONTROLS that fail open (2026-09-12). Neither is a crash and
  // neither stops the book — that is the point: on a provider or broker
  // outage the cap simply admits more than it should, and until these rows
  // existed nothing anywhere said so.
  {
    action: 'live_buying_power_unavailable',
    label: 'Sizing ran unconstrained by buying power (broker read failed)',
  },
  {
    action: 'correlation_data_unavailable',
    label: 'The correlated-exposure cap under-counted (candles could not be fetched)',
  },
  // The halt's only dated record is its alert marker (dailyHaltMarker.ts).
  // `daily_drawdown_halt` is the guardrail RULE's name and was never
  // journaled as an action, and `give_back_halt` was never written either
  // (the writer is dailyTarget.ts's `daily_give_back_halted`). So neither halt
  // could ever appear here until 2026-09-23. Split by pool, because the paper
  // book halting is the control arm's bad day, not the live book's.
  {
    action: 'daily_halt_alerted',
    label: 'A daily drawdown halt tripped',
    splitOn: 'pool',
    labelFor: {
      live: 'The LIVE daily drawdown halt tripped (stock + options)',
      paper: 'The PAPER daily drawdown halt tripped (the control arm)',
    },
  },
  { action: 'daily_give_back_halted', label: 'The give-back guard halted the day' },
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
export const SKIP_ACTIONS = [
  'live_symbol_held_skipped',
  'live_score_floor_skipped',
  'symbol_reentry_cooldown_skipped',
  'symbol_cooldown_skipped',
  'live_risk_blocked',
  'live_short_skipped',
  'finish_line_skipped',
  // THREE THAT JOURNALLED AND WERE NEVER CLASSIFIED (2026-09-12). Each is a
  // per-symbol live-entry refusal written through the same
  // `journalEntrySkipOncePerDay` writer as the ones above, with a symbol on the
  // row — so the only thing keeping them out of the attribution was their
  // absence from this list, and every paper entry they refused read as
  // `no_live_row`, "nothing the journal explains".
  //
  // The score-gate one is the clearest miss: `liveEntryScoreGate` returns ONE
  // of THREE actions from one code path, and two of the three were here.
  'regime_score_floor_skipped',
  // The stop is wider than the name moves in a day. Live-only on purpose — its
  // own comment says the paper book keeps taking these "so the experiment has a
  // control group", which is exactly what this attribution is.
  'risk_atr_unreachable_skipped',
  // The broker has already refused to parse this symbol.
  'symbol_unplaceable_skipped',
  // Heavy volume inside a collapsed range — the price is being absorbed at a
  // level rather than moving (a buyout pin, a tender, a hard institutional
  // bid). Live-only for the same reason the ATR one is: paper keeps taking
  // these, which is what makes this attribution a control rather than a tally.
  'absorbed_price_skipped',
];
// NOT here: `live_entry_cutoff_skipped`. It sat in this list from the day the
// list was written and nothing has ever emitted it — the equity entry cutoff
// is gated on a measurement and was never built (the plan says so explicitly).
// A filter on an action no emitter writes reads as coverage while providing
// none, which is why `journalActionsReachability.test.ts` exists; it could not
// see this one until its own two blind spots were fixed on 2026-09-12. When
// the cutoff ships, its PR adds the action to both sides at once.
//
// NOT here either, but for the OPPOSITE reason: the two BATCH refusals below.
// They are emitted constantly, and they refuse the whole tick before any
// candidate is looked at, so their rows carry a count and NO SYMBOL. This
// collector drops symbol-less rows two lines below and the classifier matches
// on symbol, so putting them in this list would change nothing. They are read
// on their own, by time, in collectBatchRefusals.
const BATCH_REFUSAL_ACTIONS = ['entry_window_closed', 'live_entries_halted'];

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

/** The `entry_extension_shadow` rows, keyed by BOOK, symbol and minute, so an
 *  entry can be joined to what the shadow gate saw at the moment it was
 *  placed. The shadow is journaled immediately after the placement call, so
 *  the two land in the same minute.
 *
 *  The book belongs in the key (2026-09-14): both books enter the same symbol
 *  in the same tick and therefore the same minute, so a symbol-and-minute key
 *  let the live row overwrite the paper one — and the scan's whole test for a
 *  leak is whether the paper CONTROL agrees with the live book. A control that
 *  is a copy of its subject always agrees. */
export interface ExtensionRow {
  vwapExtPct: number | null;
  pctOfRange: number | null;
}

/** A pctOfRange outside 0..100 is a KNOWN-BAD measurement, not an extreme one.
 *
 *  Rows written before 2026-09-14 divided the screener's price by a range from
 *  a different moment, and five of the first 43 landed outside their own range
 *  (FCX 130.0%, FTFT 114.8%, SMCI 110.9%, BWIN 105.9%, CHYM -1.6%). Clamping
 *  them to 100 would invent a reading the data does not support; bucketing
 *  them would put a trade in a band chosen by measurement error. Dropping the
 *  attribute leaves the trade in every OTHER dimension and merely unmeasured
 *  in this one, which is what it is. `rangeIncluding` makes the condition
 *  unreachable for rows written since. */
function usablePctOfRange(v: unknown): number | null {
  return typeof v === 'number' && v >= 0 && v <= 100 ? v : null;
}

function extensionIndex(since: number): { rows: Map<string, ExtensionRow>; quality: ExtensionQuality } {
  const rows = new Map<string, ExtensionRow>();
  const quality: ExtensionQuality = { measured: 0, staleBars: 0, unusable: 0 };
  for (const e of listAutotradeEventsInWindow({ actions: ['entry_extension_shadow'], since }).events) {
    if (!e.symbol || !e.detail) continue;
    let parsed: { vwapExtPct?: unknown; pctOfRange?: unknown; book?: unknown; extendedRange?: unknown };
    try {
      parsed = JSON.parse(e.detail) as typeof parsed;
    } catch {
      continue;
    }
    const minute = etMinuteOf(e.createdAt);
    if (minute === null) continue;
    // Rows written before the paper book journaled its own were all live, and
    // carry no `book` field. Defaulting them to 'live' keeps the existing
    // history joined rather than silently orphaning every trade before today.
    const book = parsed.book === 'paper' ? 'paper' : 'live';
    const pctOfRange = usablePctOfRange(parsed.pctOfRange);
    if (pctOfRange === null && typeof parsed.pctOfRange === 'number') quality.unusable += 1;
    if (pctOfRange !== null) {
      quality.measured += 1;
      if (parsed.extendedRange === 'above' || parsed.extendedRange === 'below') quality.staleBars += 1;
    }
    rows.set(extensionKey(book, e.symbol, etToday(e.createdAt), minute), {
      vwapExtPct: typeof parsed.vwapExtPct === 'number' ? parsed.vwapExtPct : null,
      pctOfRange,
    });
  }
  return { rows, quality };
}

function extensionKey(book: 'live' | 'paper', symbol: string, etDate: string, minute: number): string {
  return `${book}|${symbol}|${etDate}|${minute}`;
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
    const ext = minute === null ? undefined : extensions.get(extensionKey('live', p.symbol, etDate, minute));
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
  extensions: Map<string, ExtensionRow>,
): Map<string, PartialLeakTrade> {
  const out = new Map<string, PartialLeakTrade>();
  for (const p of paper) {
    if (p.status !== 'closed' || p.exitAt === null) continue;
    const etDate = etToday(p.entryAt);
    const minute = etMinuteOf(p.entryAt);
    const ext = minute === null ? undefined : extensions.get(extensionKey('paper', p.symbol, etDate, minute));
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
      // Null until 2026-09-14, which is why the scan could never CONFIRM an
      // extension leak: its bar needs the paper control's bucket to agree in
      // sign, and a null control agrees with nothing. execute.ts journals the
      // paper reading now, so this joins for trades from that date on and
      // stays null for the history behind it.
      vwapExtPct: ext?.vwapExtPct ?? null,
      pctOfRange: ext?.pctOfRange ?? null,
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
  const drops: DropReasons = { ...collected.dropReasons };
  for (const t of collected.trades) {
    const attrs = attributes.get(t.id);
    if (!attrs) {
      drops.noAttributes += 1;
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
  return {
    trades,
    sessionDates: collected.sessionDates,
    droppedTrades: dropTotal(drops),
    dropReasons: drops,
  };
}

/** Execution occurrences over the last EXECUTION_LOOKBACK_SESSIONS sessions. */
export function collectExecutionFindings(now: number): ExecutionOccurrence[] {
  let date = etToday(now);
  for (let i = 0; i < EXECUTION_LOOKBACK_SESSIONS; i++) date = previousTradingSession(date);
  const since = etDateTimeToMs(date, '00:00') ?? now - EXECUTION_LOOKBACK_SESSIONS * 24 * 60 * 60 * 1000;
  // The sessions of the window, newest first, so "how many sessions ago" is an
  // index rather than a date subtraction (which would count weekends and
  // holidays as sessions and overstate how stale a class is).
  const windowSessions: string[] = [];
  {
    let d = etToday(now);
    for (let i = 0; i < EXECUTION_LOOKBACK_SESSIONS + 1; i++) {
      windowSessions.push(d);
      d = previousTradingSession(d);
    }
  }
  const counts = new Map<string, number>();
  const lastSeen = new Map<string, string>();
  for (const e of listAutotradeEventsInWindow({
    actions: EXECUTION_ACTIONS.map((a) => a.action),
    since,
  }).events) {
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
    const etDate = etToday(e.createdAt);
    const seen = lastSeen.get(key);
    if (seen === undefined || etDate > seen) lastSeen.set(key, etDate);
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
      const seen = lastSeen.get(key) ?? null;
      const idx = seen === null ? -1 : windowSessions.indexOf(seen);
      out.push({
        action: key,
        count: n,
        detail: `${label} — ${n} in the last ${EXECUTION_LOOKBACK_SESSIONS} sessions`,
        lastSeenEtDate: seen,
        // Not found in the window's session list means the row landed on a day
        // the calendar does not call a session (a holiday backfill, a clock
        // skew). Null rather than a number we would be guessing at.
        sessionsSinceLastSeen: idx >= 0 ? idx : null,
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

  // A CONCENTRATION CAP BELOW WHAT ONE POSITION COSTS (2026-09-12).
  //
  // maxSectorExposurePct and maxCorrelatedExposurePct gate capital ALREADY held
  // in names like the candidate, in NOTIONAL, excluding the candidate's own
  // size — so no amount of trimming satisfies them. Below
  // concentrationCapFloorPct a single ordinary position exceeds the entire
  // budget for its own sector or cluster, which closes that sector with its own
  // first trade at any equity and any stop. See targetTune.ts for the
  // arithmetic and the live case that found it.
  //
  // Reported, never applied: raising a cap ADDS exposure, and the standing rule
  // is that the app only ever applies the direction that reduces it.
  const capFloorPct = concentrationCapFloorPct(cfg);
  for (const [field, stored] of [
    ['maxSectorExposurePct', cfg.maxSectorExposurePct],
    ['maxCorrelatedExposurePct', cfg.maxCorrelatedExposurePct],
  ] as const) {
    if (capFloorPct <= 0 || stored <= 0 || stored >= capFloorPct) continue;
    out.push({
      id: `configuration:concentration_cap:${field}`,
      kind: 'configuration',
      label: `${field} is smaller than one position`,
      count: 1,
      detail:
        `${field} is ${stored}% of equity while the per-order cap permits a single position of ` +
        `${capFloorPct}% (riskPerTradePct ${cfg.riskPerTradePct} over a ${cfg.maxStopDistancePct}% widest stop, ` +
        'times the order cap’s headroom). One ordinary position therefore fills this budget on its own, so the ' +
        'sector or cluster is closed by its own first trade — no size, stop or equity makes room for a second.',
      lever: {
        kind: 'config',
        field,
        value: capFloorPct,
        direction: 'exposure',
        detail:
          `${capFloorPct} is the floor at which the cap stops contradicting the sizer, not a recommendation — at or ` +
          'above it the number is a diversification choice someone made. Raising a cap adds exposure, so this ' +
          'waits for the operator.',
      },
    });
  }

  // A GIVE-BACK GUARD ARMED BY ITS FIRST WINNER (2026-09-13).
  //
  // The concentration-cap disease one level up: an absolute percentage chosen
  // when a trade moved the day 1.25%, left alone when riskPerTradePct doubled.
  // The guard still FIRES correctly — arm and floor are thresholds, not a
  // window a move can jump. What the sizing changed is when it becomes live:
  // the 2% arm was 1.60R and is now 0.80R, so one 1R winner arms it and the
  // next loser lands the day at 0%, and a guard named for protecting +1%
  // settles at roughly flat after two trades.
  //
  // The band being thinner than one step is NOT the trigger — it was 0.80R
  // against a 1.00R step at the old sizing too, where the guard was doing its
  // job, and a check that also fired there would say nothing about the change.
  //
  // Reported, never applied, and deliberately with NO recommended value:
  // widening the band lets the book keep trading on a fading day, which adds
  // exposure. Inside a 1.2R goal there may be no coherent band at all, and
  // that is the operator's call to make with the arithmetic in hand rather
  // than the app's to guess.
  const armed = giveBackArmedByOneTrade(cfg);
  if (armed) {
    out.push({
      id: 'configuration:give_back_armed_by_one_trade',
      kind: 'configuration',
      label: 'One winner arms the give-back guard',
      count: 1,
      detail:
        `The guard arms at ${cfg.giveBackArmPct}% while one ${cfg.targetRMultiple}R winner moves the day ` +
        `${armed.stepPct}% (riskPerTradePct ${cfg.riskPerTradePct}) — an arm at ${armed.armR}R and a floor at ` +
        `${armed.floorR}R against a 1.00R step. So a single winner arms it without banking, the next loser crosses ` +
        `the ${armed.bandPct}% band in one move, and the day halts at roughly flat rather than at the ` +
        `${cfg.giveBackFloorPct}% the guard is named for.`,
      lever: {
        kind: 'config',
        field: 'giveBackArmPct',
        value: null,
        direction: 'exposure',
        detail:
          'No value is proposed. Widening the band keeps the book trading on a fading day, which adds exposure; ' +
          (cfg.targetDailyGainPct !== null && cfg.targetDailyGainPct > 0
            ? `inside a goal only ${Math.round((cfg.targetDailyGainPct / cfg.riskPerTradePct) * 100) / 100}R wide `
            : 'inside this goal ') +
          'there may be no band a 1.00R step cannot cross, in which case the choice is between accepting the guard ' +
          'as "stop once a winner is given back", switching it off and relying on the daily halt and the step-down, ' +
          'or moving the goal.',
      },
    });
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

/**
 * The batch-level live refusals within the window — the two that name no
 * symbol, so the only ones the attribution can match by time alone.
 *
 * Without these, every paper entry the live book declined because the flatten
 * was about to swallow it, or because the live book had stood down for the day,
 * was reported as `no_live_row`: the bucket that means "nothing the journal
 * explains", the largest one on the book, and the one the evening routine
 * watches. Gates doing exactly their job were reading as holes in the record.
 */
function collectBatchRefusals(since: number): BatchRefusal[] {
  const { events } = listAutotradeEventsInWindow({ actions: BATCH_REFUSAL_ACTIONS, since });
  return events.map((e) => ({ at: e.createdAt, action: e.action }));
}

/**
 * How far the placement quote had drifted from the price the sizer used, per
 * live entry in the window (2026-09-13).
 *
 * Read off `live_order_placed`, which carries both prices precisely so this
 * question stays answerable: `signalEntry` is what riskCheck sized against and
 * `riskBasisPrice` is the placement quote. NOT the limit — the limit is the
 * signal's price plus the buffer plus the drift, and the finding's bar IS the
 * buffer, so measuring against the limit would compare the buffer to itself
 * and fire on every book. Signed so positive is ADVERSE on both sides — a buy
 * paying up, a short selling down — because an unsigned mean would let the two
 * directions cancel and report a calm book.
 *
 * Rows predating the field are skipped rather than reconstructed from
 * `plannedStopDistancePct`: that reconstruction is exact only while the stop
 * sat at the cap, and a silently-wrong drift is worse than a shorter window.
 */
function collectEntryDrift(since: number): number[] {
  const { events } = listAutotradeEventsInWindow({ actions: ['live_order_placed'], since });
  const out: number[] = [];
  for (const e of events) {
    if (!e.detail) continue;
    let parsed: { signalEntry?: unknown; riskBasisPrice?: unknown; side?: unknown };
    try {
      parsed = JSON.parse(e.detail) as typeof parsed;
    } catch {
      continue;
    }
    const { signalEntry, riskBasisPrice, side } = parsed;
    if (typeof signalEntry !== 'number' || typeof riskBasisPrice !== 'number') continue;
    if (side !== 'buy' && side !== 'sell') continue;
    const drift = entryDriftPct(signalEntry, riskBasisPrice, side);
    if (drift !== null) out.push(drift);
  }
  return out;
}

/** Live-book skips within the window, for the attribution's untaken classes. */
function collectJournalSkips(since: number): { skips: JournalSkip[]; truncated: boolean } {
  // WINDOWED, not capped. `listAutotradeEvents` clamps to ROW_CAP silently,
  // and this window held 1,928 skip rows on 2026-09-12 — see
  // listAutotradeEventsInWindow's comment for what that cost.
  const { events, truncated } = listAutotradeEventsInWindow({ actions: SKIP_ACTIONS, since });
  const skips = events
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
  return { skips, truncated };
}

/**
 * THE OPTIONS SLEEVE, which nothing else in this scan can see (2026-09-12).
 *
 * The plan counts the short-dated options sleeve as part of the 3% — its paper
 * book averaged +17% of premium over 20 trades. But every instrument here is
 * equity-shaped: the paired attribution matches paper EQUITY entries to live
 * EQUITY entries, `EXECUTION_ACTIONS` lists no options entry class, and the
 * word "options" does not appear in the tune advisor at all. So the sleeve
 * could stop trading entirely and no report would say so.
 *
 * It had very nearly stopped. Over 2026-09-08..09 the live options book
 * refused 29 of 31 candidates with `failedRules[0] === 'quantity'`, the check
 * whose own message reads "risk budget is too small to size even one contract
 * at $2.93 premium (risking 70% of it)". Two orders got through. Nothing
 * reported the other twenty-nine.
 *
 * This is NOT an execution defect — no code is misbehaving. It is arithmetic
 * on a small account: one contract of a $2.93 option risks $205 at a 70%
 * disaster stop, and the sleeve's per-trade budget was a fraction of that. So
 * it is reported as a `configuration` finding, with the binding number said
 * out loud rather than left for the reader to derive.
 *
 * That example was the account at ~$5k. Since 2026-09-23 the example and the
 * advice are computed from the refusals themselves, split against today's
 * full-size ceiling (see WHICH KIND OF REFUSAL below).
 */
export function collectOptionsFlowFindings(cfg: AutotradeConfig, now: number): ScanFinding[] {
  let date = etToday(now);
  for (let i = 0; i < EXECUTION_LOOKBACK_SESSIONS; i++) date = previousTradingSession(date);
  const since = etDateTimeToMs(date, '00:00') ?? now - EXECUTION_LOOKBACK_SESSIONS * 24 * 60 * 60 * 1000;

  const { events } = listAutotradeEventsInWindow({ actions: ['live_options_risk_blocked'], since });
  let sized = 0;
  let lastSeen: string | null = null;
  /** Each refusal's own premium, when its row carries one (rows from before the
   *  field existed do not). */
  const refused: { premium: number; symbol: string | null; at: number }[] = [];
  // `failedRules` is an ARRAY, so detailValue (which returns a string) cannot
  // read it. Parsed directly rather than widening that helper for one caller.
  for (const e of events) {
    if (e.detail === null) continue;
    let rule: string | null = null;
    let premium: number | null = null;
    try {
      const parsed = JSON.parse(e.detail) as { failedRules?: unknown; premium?: unknown };
      const rules = parsed.failedRules;
      if (Array.isArray(rules) && typeof rules[0] === 'string') rule = rules[0];
      if (typeof parsed.premium === 'number' && Number.isFinite(parsed.premium) && parsed.premium > 0) {
        premium = parsed.premium;
      }
    } catch {
      rule = null;
    }
    if (rule !== 'quantity') continue;
    sized += 1;
    if (premium !== null) refused.push({ premium, symbol: e.symbol, at: e.createdAt });
    const d = etToday(e.createdAt);
    if (lastSeen === null || d > lastSeen) lastSeen = d;
  }
  if (sized === 0) return [];

  const placed = listAutotradeEventsInWindow({ actions: ['live_options_order_placed'], since }).events.length;
  const probation = getOptionsProbationStatus(cfg);
  // PROBATION DOES NOT MOVE THIS CEILING, at any account size (2026-09-12).
  //
  // This used to multiply the ceiling by the probation factor, with a comment
  // calling it "the same halving the sizer applies". The sizer does not halve
  // here. `optionsRiskCheck` decides affordability FIRST — a candidate is
  // sizeable when `floor(riskDollars / (premium x lossFraction x 100)) >= 1`,
  // which never mentions probation — and `liveOptionsExecute` then scales the
  // CONTRACT COUNT it was handed, clamped to a minimum of one
  // (`Math.max(1, Math.floor(rawQuantity * multiplier))`, whose own comment
  // says "at one contract there is nothing left to cut"). So probation changes
  // how many contracts are bought, never the largest premium one contract may
  // cost, and it cannot turn an affordable candidate into a refused one.
  //
  // The halved figure was therefore wrong in the one direction that matters:
  // it named probation as the binding constraint, and the lever told the
  // operator to wait it out. At this account the sizer reaches exactly one
  // contract, so waiting for probation to end would change nothing at all —
  // advice to do nothing about a sleeve that is refusing 94% of its
  // candidates. Every refusal counted above is a `quantity` refusal, decided
  // before probation is consulted.
  const ceiling = maxAffordablePremiumPerShare({
    equityUsd: cfg.accountEquityUsd ?? 0,
    riskPctUpperBound: riskPctUpperBound(cfg),
    disasterStopPct: cfg.optionsDisasterStopPct,
  });

  const pct = placed + sized > 0 ? Math.round((sized / (placed + sized)) * 100) : 0;

  // WHICH KIND OF REFUSAL (2026-09-23). Measured against TODAY's ceiling (the
  // most the sizer can reach: full risk at the largest method weight), a
  // refused premium is one of two things. Above it, no trade at this equity
  // could carry the contract. At or under it, the budget that refused it sat
  // below its most: the step-down after losing trades or another cut, a method
  // weight under its maximum, or a smaller account at the time. The first
  // argues about the sleeve and the second does not.
  //
  // The lever used to hard-code a $5k-era example ("a $2.93 option risks $205
  // … decide the sleeve does not suit an account this size"). At $26k it still
  // said that over 32 refusals of which 22 fit today's ceiling: 20 from the $5k
  // days, and MU at $8.77 on 09-22 under the step-down's 50% cut.
  const above = refused.filter((r) => r.premium > ceiling + 1e-9);
  const within = refused.filter((r) => r.premium <= ceiling + 1e-9);
  const latest = refused.reduce<(typeof refused)[number] | null>((a, r) => (a === null || r.at > a.at ? r : a), null);
  const splitClause =
    refused.length > 0
      ? ` Of the ${refused.length} with a recorded premium, ${above.length} cost more than that and ` +
        `${within.length} did not (refused while the budget sat below its most: a step-down or other cut, a ` +
        'method weight under its maximum, or a smaller account at the time)'
      : '';
  const example =
    latest !== null
      ? `The latest, ${latest.symbol ?? 'a contract'} on ${etToday(latest.at)}, was $${latest.premium.toFixed(2)}: ` +
        // premium x (stop% / 100) x 100 shares, multiplied as premium x stop%
        // so an exact $13.25 x 70 reads $928, not 927.4999… from x 0.7 x 100.
        `one contract risks $${(latest.premium * cfg.optionsDisasterStopPct).toFixed(0)} at a ` +
        `${cfg.optionsDisasterStopPct}% disaster stop, against the largest affordable premium of ` +
        `$${ceiling.toFixed(2)}/share today. `
      : '';
  const aboveAdvice =
    above.length > 0
      ? `${above.length} were priced above the most any trade can carry at this equity: trade the sleeve on ` +
        'names whose premium fits, or raise the equity behind it' +
        (above.length > within.length ? ', or decide the sleeve does not suit an account this size' : '') +
        '. '
      : '';
  const withinAdvice =
    within.length > 0
      ? `${within.length} fit that ceiling, so a budget below its most refused them (a cut, a method weight ` +
        'under its maximum, or a smaller account), which is the sizing working rather than the sleeve failing. '
      : '';
  return [
    {
      id: 'configuration:options_unsizable',
      kind: 'configuration',
      label: 'The options sleeve cannot size a contract',
      count: sized,
      lastSeenEtDate: lastSeen,
      detail:
        `${sized} of ${placed + sized} live options candidates (${pct}%) were refused because the risk budget ` +
        `could not size one contract, in the last ${EXECUTION_LOOKBACK_SESSIONS} sessions` +
        `${lastSeen === null ? '' : `, most recently ${lastSeen}`}. At $${(cfg.accountEquityUsd ?? 0).toFixed(0)} ` +
        `equity and a ${cfg.optionsDisasterStopPct}% disaster stop the largest affordable premium is ` +
        `$${ceiling.toFixed(2)}/share` +
        (probation.active
          ? ` — unchanged by probation (${probation.multiplier}x, ${probation.tradesRemaining} trades left), which ` +
            'scales the contract COUNT with a one-contract floor and so cannot lower what a contract may cost'
          : '') +
        '.' +
        (splitClause ? `${splitClause}.` : ''),
      lever: {
        kind: 'code',
        field: null,
        value: null,
        direction: 'research',
        detail:
          'Not a defect and not a knob. ' +
          example +
          aboveAdvice +
          withinAdvice +
          'Probation is NOT the constraint — it scales the contract count, not the premium a contract may cost, ' +
          'and at one contract it is inert — so waiting it out changes nothing. Decide deliberately rather than ' +
          'letting it refuse quietly.',
      },
    },
  ];
}

// ---------------------------------------------------------------------------
// THE SCORING SHADOW NOBODY WAS READING (2026-09-12).
//
// `relvol_pace_scoring_shadow` has been journaled once per tick since the pace
// scoring shipped behind a flag — roughly 200 rows a session, on the deployed
// box for weeks. The spec wrote the decision rule beside it: "Read a few
// sessions... If `wouldNewlyPass` and `wouldNewlyFail` are both small the
// change is cosmetic and the flag is not worth the risk. If the set turns over
// materially, then `liveMinSignalScore` has to be re-fitted against the
// pace-scored distribution BEFORE the flag goes on."
//
// Nothing read it. Not the scan, not the tune advisor, not the daily routine —
// the reading depended on someone remembering the row existed, which is the
// exact failure mode `docs/STRATEGY_PLAYBOOK.md`'s "Rules that apply
// themselves" is written against, and Decision 11's "leaks are found by the
// app, not by the operator".
//
// When it was finally read (2026-09-09..11, ~195 ticks a session) the answer
// was not cosmetic and was one-sided: about **15 symbols newly PASS per tick
// against 0.3 newly failing**, on ~480 scored, with the mean total score up
// about **+2.2 points**. A uniform lift of that size against a floor fitted to
// the raw distribution is a floor about two points lower than the one anyone
// agreed to — which is precisely why the spec says re-fit first.
//
// So this reports, and it reports as RESEARCH. Enabling the flag widens the
// candidate set, which adds exposure, so it is the operator's call and never
// the app's; and the re-fit is work to be scoped, not a knob to turn.
//
// AND ONCE THE FLAG IS ON, THE FLOOR IS RE-CHECKED (2026-09-19). The flag went
// on 2026-09-14 with the floor raised 72 → 81, the pace-scored equivalent the
// re-fit measured. From that moment this finding went silent, so nothing asked
// whether 81 was STILL the equivalent as the score distribution moved — and
// Friday 09-18's in-session ladder read the equivalent at 74.8, with the floor
// admitting 13.6 symbols a tick against the 21.3 that raw-72 admits. The ladder
// is counted both ways on every tick either way, so the same translation is
// re-run here against the current floor and reported when it has drifted by
// more than a rung. LOWERING the floor admits more entries and is never the
// app's to apply; the lever carries the direction so the reader cannot mistake
// the two.
// ---------------------------------------------------------------------------

/** Share of the scored universe that must change sides before the flag is more
 *  than cosmetic. One percent of ~480 symbols is ~5 a tick — small enough to
 *  catch a real turnover, large enough that noise does not report itself. */
export const SCORING_SHADOW_TURNOVER_PCT = 1;

/** The RAW floor the pace floor was fitted to be neutral against: 72, the
 *  live floor fitted against realized P&L in PR #44 and in force until pace
 *  scoring went on (2026-09-14, 72 → 81). It is the yardstick of every
 *  re-check, so it is a written decision here rather than a config value that
 *  would follow the floor it is meant to judge. A deliberate re-fit against
 *  realized P&L under pace scoring is what changes it. */
export const PACE_SCORING_RAW_REFERENCE_FLOOR = 72;

/** How far the re-fitted equivalent may sit from the floor in force before it
 *  is reported: one rung of the ladder around the live band (2 points). */
export const PACE_FLOOR_DRIFT_POINTS = 2;

export function collectScoringShadowFinding(cfg: AutotradeConfig, now: number): ScanFinding[] {
  let date = etToday(now);
  for (let i = 0; i < EXECUTION_LOOKBACK_SESSIONS; i++) date = previousTradingSession(date);
  const since = etDateTimeToMs(date, '00:00') ?? now - EXECUTION_LOOKBACK_SESSIONS * 24 * 60 * 60 * 1000;

  const { events } = listAutotradeEventsInWindow({ actions: ['relvol_pace_scoring_shadow'], since });
  let ticks = 0;
  let compared = 0;
  let pass = 0;
  let fail = 0;
  let delta = 0;
  let zeroRaw = 0;
  let zeroPace = 0;
  let enabled = false;
  let lastSeen: string | null = null;
  // The ladder, summed rung-by-rung across ticks. Shape is taken from the
  // rows themselves so an older row written before SCORE_LADDER existed (or a
  // future row with a different ladder) is skipped rather than mis-summed.
  let ladder: number[] | null = null;
  let ladderRaw: number[] = [];
  let ladderPace: number[] = [];
  let ladderTicks = 0;
  for (const e of events) {
    if (e.detail === null) continue;
    let d: Record<string, unknown>;
    try {
      d = JSON.parse(e.detail) as Record<string, unknown>;
    } catch {
      continue;
    }
    const num = (k: string): number => (typeof d[k] === 'number' ? (d[k] as number) : 0);
    // The flag being ON makes this row a record of what the OLD scoring would
    // do — the decision is already made, and re-reporting it would nag about a
    // choice the operator has taken.
    if (d.enabled === true) enabled = true;
    // While the flag is on, only rows the loop wrote under it feed the
    // re-check: a screen run from the route with a body override writes a row
    // under whatever scoring the body chose, and would sum a different
    // distribution into the same ladder.
    if (cfg.relVolUsePaceScoring && d.enabled !== true) continue;
    ticks += 1;
    compared += num('compared');
    pass += num('wouldNewlyPass');
    fail += num('wouldNewlyFail');
    delta += num('meanTotalDelta');
    zeroRaw += num('relVolComponentZeroRaw');
    zeroPace += num('relVolComponentZeroPace');
    const rungs = d.scoreLadder;
    const raw = d.ladderRawAtOrAbove;
    const pace = d.ladderPaceAtOrAbove;
    if (
      Array.isArray(rungs) &&
      Array.isArray(raw) &&
      Array.isArray(pace) &&
      rungs.length > 1 &&
      raw.length === rungs.length &&
      pace.length === rungs.length &&
      (ladder === null || ladder.length === rungs.length)
    ) {
      if (ladder === null) {
        ladder = rungs as number[];
        ladderRaw = rungs.map(() => 0);
        ladderPace = rungs.map(() => 0);
      }
      for (let i = 0; i < rungs.length; i++) {
        ladderRaw[i] += Number(raw[i]) || 0;
        ladderPace[i] += Number(pace[i]) || 0;
      }
      ladderTicks += 1;
    }
    const day = etToday(e.createdAt);
    if (lastSeen === null || day > lastSeen) lastSeen = day;
  }
  if (ticks === 0 || compared === 0) return [];
  if (cfg.relVolUsePaceScoring) return paceFloorDriftFinding(cfg, ladder, ladderRaw, ladderPace, ladderTicks, lastSeen);
  // The flag is off now, but a row in the window was written with it on: the
  // decision was taken and then reverted inside the window, and re-reporting
  // the pre-enable case would nag about a choice already made once.
  if (enabled) return [];

  const perTick = (n: number): number => Math.round((n / ticks) * 10) / 10;
  // The floor that preserves today's selectivity under the other scoring —
  // the number the spec's "re-fit before the flag goes on" rule asks for.
  const equivalentFloor =
    ladder !== null && ladderTicks > 0
      ? equivalentPaceFloor(ladder, ladderRaw, ladderPace, cfg.liveMinSignalScore)
      : null;
  const turnoverPct = ((pass + fail) / compared) * 100;
  if (turnoverPct < SCORING_SHADOW_TURNOVER_PCT) return [];

  return [
    {
      id: 'configuration:relvol_pace_scoring_shadow',
      kind: 'configuration',
      label: 'Pace scoring would change which symbols the screen picks',
      count: ticks,
      lastSeenEtDate: lastSeen,
      detail:
        `Over ${ticks} ticks, pace scoring would newly PASS ${perTick(pass)} symbols a tick and newly FAIL ` +
        `${perTick(fail)}, out of ${perTick(compared)} scored — ${turnoverPct.toFixed(1)}% of the universe changing ` +
        `sides, against a ${SCORING_SHADOW_TURNOVER_PCT}% "cosmetic" bar. Mean total score moves ` +
        `${perTick(delta) >= 0 ? '+' : ''}${perTick(delta)} points, and symbols scoring ZERO on the ` +
        `relative-volume component fall from ${perTick(zeroRaw)} to ${perTick(zeroPace)} a tick.` +
        (equivalentFloor === null
          ? ' The equivalent floor is not yet measurable — the ladder has not run, or the live floor sits outside it.'
          : ` THE RE-FIT: pace scoring admits as many symbols at a floor of ${equivalentFloor} as the live ` +
            `liveMinSignalScore of ${cfg.liveMinSignalScore} admits under raw scoring, measured over ${ladderTicks} ` +
            'ticks of the score ladder rather than inferred from the mean shift.'),
      lever: {
        kind: 'code',
        field: null,
        value: null,
        direction: 'research',
        detail:
          'Not a switch to flip. The turnover is one-sided — it WIDENS the candidate set, which adds exposure, so ' +
          "enabling relVolUsePaceScoring is the operator's call. And the spec's own rule comes first: a uniform " +
          'lift in total score against a liveMinSignalScore fitted to the RAW distribution is a floor nobody agreed ' +
          'to lower, so re-fit that floor against the pace-scored distribution BEFORE the flag goes on, not after.',
      },
    },
  ];
}

/**
 * The floor's standing while pace scoring is on: the re-fit, recomputed over
 * the window's ladder against the raw reference floor, reported only when it
 * sits more than a rung from the floor in force. A ladder that cannot answer
 * (not written yet, or either floor off its ends) says nothing rather than
 * naming a number.
 */
function paceFloorDriftFinding(
  cfg: AutotradeConfig,
  ladder: number[] | null,
  ladderRaw: number[],
  ladderPace: number[],
  ladderTicks: number,
  lastSeen: string | null,
): ScanFinding[] {
  if (ladder === null || ladderTicks === 0) return [];
  const floor = cfg.liveMinSignalScore;
  const drift = paceFloorDrift(ladder, ladderRaw, ladderPace, PACE_SCORING_RAW_REFERENCE_FLOOR, floor);
  if (drift === null || Math.abs(drift.driftPoints) < PACE_FLOOR_DRIFT_POINTS) return [];
  const perTick = (n: number): number => Math.round((n / ladderTicks) * 10) / 10;
  // The floor sits ABOVE its equivalence: it admits fewer symbols than the
  // fitted reference, and the lever LOWERS it — which adds entries.
  const tighter = drift.driftPoints < 0;
  return [
    {
      id: 'configuration:relvol_pace_floor_drift',
      kind: 'configuration',
      label: tighter
        ? 'The live score floor has drifted above its pace-scored equivalence'
        : 'The live score floor has drifted below its pace-scored equivalence',
      count: ladderTicks,
      lastSeenEtDate: lastSeen,
      detail:
        `Pace scoring is ON with liveMinSignalScore ${floor}. Over ${ladderTicks} ticks of the score ladder the ` +
        `floor admits ${perTick(drift.admittedAtFloor)} symbols a tick, while the raw floor of ` +
        `${PACE_SCORING_RAW_REFERENCE_FLOOR} it was fitted to be neutral against admits ` +
        `${perTick(drift.admittedAtReference)}. The pace-scored equivalent of that reference now reads ` +
        `${drift.equivalentFloor} — ${Math.abs(drift.driftPoints)} points ${tighter ? 'below' : 'above'} the floor ` +
        `in force, against a ${PACE_FLOOR_DRIFT_POINTS}-point bar. The live book is seeing ` +
        `${tighter ? 'fewer' : 'more'} candidates than the fitted floor intended.`,
      lever: {
        kind: 'config',
        field: 'liveMinSignalScore',
        value: drift.equivalentFloor,
        // Lowering the floor admits entries the book refuses today.
        direction: tighter ? 'exposure' : 'safe',
        detail: tighter
          ? `Setting liveMinSignalScore to ${drift.equivalentFloor} restores the fitted flow. It LOWERS the floor, ` +
            "which adds exposure, so it is the operator's call — never applied by the app. Confirm the drift " +
            'holds on a second evening first; a single busy or quiet session moves the ladder.'
          : `Setting liveMinSignalScore to ${drift.equivalentFloor} restores the fitted selectivity. It RAISES the ` +
            'floor, which refuses entries the book takes today, so it is a flow cut: confirm the drift holds on a ' +
            'second evening before applying it.',
      },
    },
  ];
}

/**
 * The re-entry cooldown's finding, read from the record the loop persisted
 * after the last close (reentryShadowRecordData.ts) — never recomputed here,
 * because the record needs provider bars and this scan reads only the
 * database. No record yet (before the first after-close tick on this build)
 * reads as silence, not as evidence. The rng is the scan's own seed so the
 * bootstrap interval is the same on every run of the same record.
 */
export function collectReentryCooldownFinding(cfg: AutotradeConfig): ScanFinding[] {
  return reentryCooldownFinding(
    reentryShadowEvidenceOf(getLastReentryShadowRecord()),
    cfg.symbolReentryCooldownMinutes,
    mulberry32(SCAN_RNG_SEED),
  );
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

  // One scan of the journal, read by both books — the index is keyed by book,
  // so each takes its own rows out of it.
  const { rows: extensions, quality: extensionQuality } = extensionIndex(windowStart);
  const live = joinLeakTrades(
    liveCollected,
    attributesForLiveBook(
      listPositions({ status: 'closed' }),
      listLiveOptionsPositions({ status: 'closed' }),
      sectorOf,
      extensions,
    ),
  );
  const paper = joinLeakTrades(
    paperCollected,
    attributesForPaperBook(
      listPaperPositions({ status: 'closed' }),
      listOptionsPaperPositions({ status: 'closed' }),
      sectorOf,
      extensions,
    ),
  );

  // Entry slippage over the window, in % of the limit price. Entries only: an
  // exit's slippage is the chase doing its job, and pooling the two would hide
  // the number the attribution is actually about.
  const skipRead = collectJournalSkips(windowStart);
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
    configuration: [
      ...collectConfigurationFindings(cfg, now),
      ...collectOptionsFlowFindings(cfg, now),
      ...collectScoringShadowFinding(cfg, now),
      ...collectReentryCooldownFinding(cfg),
    ],
    entrySlippagePct,
    entryLimitBufferPct: MARKETABLE_LIMIT_BUFFER_PCT,
    entryDriftPct: collectEntryDrift(windowStart),
    journalSkips: skipRead.skips,
    journalSkipsTruncated: skipRead.truncated,
    extensionQuality,
    batchRefusals: collectBatchRefusals(windowStart),
    asOf: now,
  });
}
