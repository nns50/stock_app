import { db } from './index';
import { IndicatorKey, IndicatorWeights, defaultScreenerConfig } from '../indicators/screener';

/** The three regimes the market-regime gauge (services/marketRegime.ts) resolves
 *  to. Keyed camelCase here to match the config field names. */
export interface RegimeWeightPresets {
  riskOn: IndicatorWeights;
  neutral: IndicatorWeights;
  riskOff: IndicatorWeights;
}

// ---------------------------------------------------------------------------
// Persistence for the auto-trading master switch + active risk profile (see
// docs/AUTOTRADING_SPEC.md — Risk Profiles). Stored as one JSON row, same
// singleton-upsert shape as trading_config (db/trading.ts), so adding a field
// later needs no migration.
//
// This only stores settings — it does NOT run the execution loop or evaluate
// risk. `enabled` here is scoped to the auto-trading loop specifically; it is
// independent of the live-trading TRADING_ENABLED env gate and kill switch
// (db/trading.ts), which guard the human-confirmed order pipeline this loop
// will eventually place orders through.
// ---------------------------------------------------------------------------

export type RiskProfileName = 'MODERATE' | 'AGGRESSIVE';

/** Which side(s) of the market the equity screener/decision engine looks
 *  for a setup in. 'long' (default) preserves the original behavior exactly
 *  — the loop only ever screens for and takes long positions. 'short' scores
 *  every candidate as a short instead. 'both' scores every candidate BOTH
 *  ways (indicators/screener.ts's scoreSymbolBothDirections) and keeps
 *  whichever direction actually qualifies PER SYMBOL — this is what lets the
 *  loop hold a long on one symbol and a short on another from the same
 *  cycle, rather than picking one global direction for the whole batch.
 *  Equity-only: options direction (call vs put) is derived from the SAME
 *  per-candidate read once this exists, not a separate setting.
 *
 *  A 'short'/'both' candidate reaching LIVE execution still has to clear
 *  liveAllowNakedShort below — this setting decides what the loop LOOKS
 *  for, not whether a live short order is actually allowed to place; paper
 *  trading has no equivalent gate (services/trading/guardrails.ts is never
 *  in its path), so enabling this alone is enough to see short paper
 *  positions. */
export type TradeDirectionMode = 'long' | 'short' | 'both';

/** Which options strategy shape the loop builds (docs/AUTOTRADING_SPEC.md,
 *  phase 9/10's own deferred "debit spread" follow-up). 'single_leg' (long
 *  call/put) by default — a debit spread caps both max loss AND max gain, a
 *  genuinely different risk/reward trade a human should opt into explicitly,
 *  not something the loop silently switches to based on market conditions.
 *  'auto' (2026-07-18) is the one deliberate exception to that: it picks
 *  single_leg vs. debit_spread PER CANDIDATE from that candidate's own IV
 *  rank (see optionsDecide.ts's AUTO_STRATEGY_IV_RANK_THRESHOLD) — still an
 *  explicit opt-in a human chooses once, not a silent default. */
export type OptionsStrategyType = 'single_leg' | 'debit_spread' | 'auto';

export interface AutotradeConfig {
  /** Master on/off for the auto-trading execution loop. */
  enabled: boolean;
  /** Sticky emergency halt (docs/AUTOTRADING_SPEC.md — Phase 7's resolved kill-switch
   *  decision), independent of `enabled` — mirrors db/trading.ts's TradingConfig.killSwitch.
   *  Engaging it blocks new entries immediately; it does NOT force-close open paper
   *  positions (see loop.ts — checkPaperExits() always runs regardless of this flag, since
   *  in paper mode this loop IS the only thing that can enforce an already-open position's
   *  stop/target). Independent of `enabled` so releasing it resumes the loop automatically
   *  without the user needing to re-arm "enabled" too. */
  killSwitch: boolean;
  /** Active risk profile. Defaults to MODERATE; switching to AGGRESSIVE is
   *  gated by an explicit confirmation at the route (see routes/autotrade.ts). */
  riskProfile: RiskProfileName;
  /** Account equity (USD) the risk engine sizes trades and computes its %
   *  caps against. No live broker balance is wired in yet (see
   *  services/autotrading/riskCheck.ts) — set this manually. Null until set;
   *  the risk engine fails closed (blocks everything) while it's unset. */
  accountEquityUsd: number | null;
  /** ONE combined budget for open positions — equity and options positions
   *  share this same pool (see services/autotrading/optionsRiskCheck.ts's
   *  header comment on why: the spec calls for one combined risk budget, not
   *  separate pools). Used to live baked into RiskProfileParams, swinging with
   *  MODERATE/AGGRESSIVE; now directly configurable so switching profile
   *  doesn't silently change a cap the user explicitly set. */
  maxConcurrentPositions: number;

  // --- Risk-check parameters (docs/AUTOTRADING_SPEC.md — RISK PROFILES).
  // Every field below used to live in riskProfiles.ts's MODERATE/AGGRESSIVE
  // preset table, swinging whenever riskProfile changed. Moved out
  // 2026-07-10, same treatment (and same reasoning) as maxConcurrentPositions
  // above — reported directly: raising maxConcurrentPositions alone (to 15)
  // didn't unblock new entries with only 2 positions open, because
  // maxAggregateOpenRiskPct — 2% of equity at the old MODERATE preset, about
  // 2 positions' worth of risk at 1%/trade — was the one actually binding,
  // and had no independent lever at all. Defaults below match the old
  // MODERATE preset exactly, so an untouched config's behavior doesn't
  // change; riskProfile itself no longer has ANY computational effect on
  // these (see riskProfiles.ts's header comment) — it's kept purely as a
  // label (still gates the AGGRESSIVE-switch confirmation dialog). ------

  /** % of account equity risked per trade (before any step-down cut). */
  riskPerTradePct: number;
  /** % daily drawdown (of equity) that halts new entries for the rest of the day. */
  maxDailyDrawdownPct: number;
  /** Consecutive losing trades that trigger step-down sizing. */
  stepDownAfterLosses: number;
  /** % cut to riskPerTradePct once step-down is active. */
  stepDownSizeCutPct: number;
  /** % of equity — sum(size × stop distance) across open + proposed
   *  positions (the CRITICAL pre-trade check — see riskCheck.ts). ONE
   *  combined budget shared by equity + options, same pool as
   *  maxConcurrentPositions above. */
  maxAggregateOpenRiskPct: number;
  /** % of equity — capital (not risk) already concentrated in tickers
   *  statistically correlated (|r| ≥ 0.7 over 30 trading days —
   *  riskProfiles.ts's CORRELATION_THRESHOLD/CORRELATION_LOOKBACK_DAYS,
   *  still fixed methodology constants, not user-tunable) with the candidate. */
  maxCorrelatedExposurePct: number;
  /** % of equity — capital (not risk) already concentrated in the candidate's
   *  OWN universe sector (db/universe.ts's `sector` column), regardless of
   *  price correlation. A complementary, cheaper backstop to
   *  maxCorrelatedExposurePct above (see riskCheck.ts's sectorNotional() doc
   *  comment): two names in the same sector can carry LOW price correlation
   *  today and still share the same macro/sector-wide risk the correlation
   *  cap alone would miss. Defaults on (like maxCorrelatedExposurePct) rather
   *  than opt-in, since this is a passive safety cap, not an active-automation
   *  toggle — same category as every other risk-check cap on this list. */
  maxSectorExposurePct: number;
  /** Max entries (paper + live combined) risk-check will approve per day. */
  maxTradesPerDay: number;
  /** Regime-aware sizing (added 2026-07-16, follow-up to phase 17 — see
   *  docs/AUTOTRADING_SPEC.md phase 18): a SOFTER, graduated companion to
   *  `maxMarketAtrPct` above, keyed to the SAME broad-market-proxy (SPY) ATR%
   *  reading `maxMarketAtrPct` already computes once per loop cycle (see
   *  executionGuards.ts's getMarketAtrPct) — no new fetch. Where
   *  `maxMarketAtrPct` is a hard cutoff (blocks EVERY new entry once
   *  tripped), this cuts POSITION SIZE once market ATR% crosses this lower
   *  threshold, exactly like `stepDownSizeCutPct` cuts size after a losing
   *  streak — same insertion point (a multiplicative cut to
   *  `riskPerTradePct`, before sizing math), and stacks WITH step-down if
   *  both are active at once (multiplicative, matching how step-down and
   *  live probation already stack). Intended to sit below
   *  `maxMarketAtrPct`'s own threshold (elevated-but-not-extreme volatility
   *  sizes down; extreme volatility still blocks entirely) — not enforced
   *  against each other, same as every other pair of independently-editable
   *  guardrail fields in this config. LIVE + PAPER only, same scope boundary
   *  as `maxMarketAtrPct` itself: a historical backtest has no live SPY-proxy
   *  ATR series wired in (see that field's own note below), so this has no
   *  backtest equivalent either. */
  regimeAtrThresholdPct: number;
  /** % cut to riskPerTradePct once regimeAtrThresholdPct is active. Defaults
   *  to 0 (disabled) — unlike stepDownSizeCutPct (a pre-existing, always-on
   *  behavior this config merely made tunable), this is a brand-new feature,
   *  so an untouched config changes nothing. */
  regimeSizeCutPct: number;
  /** Equity-curve de-risking (2026-07-24, services/autotrading/equityCurveDerisk.ts):
   *  a SOFTER, graduated companion to the binary `maxDailyDrawdownPct` halt.
   *  When on, and the strategy's OWN realized equity curve (cumulative closed
   *  P&L, per book — paper vs live) is below its `equityCurveLookbackDays`-day
   *  moving average, `riskPerTradePct` is cut by `equityCurveDeriskCutPct` — the
   *  same multiplicative insertion point step-down and regime sizing use, and it
   *  stacks with them. Off by default (`equityCurveDeriskEnabled` false), so an
   *  untouched config changes nothing. LIVE + PAPER only — a backtest has no live
   *  per-book curve wired into its risk-check context (same scope boundary as
   *  regime sizing). */
  equityCurveDeriskEnabled: boolean;
  equityCurveLookbackDays: number;
  equityCurveDeriskCutPct: number;
  /** ADV participation cap (2026-07-24): max % of a name's ~20-day average
   *  daily volume a single equity position may take, so a position stays
   *  exitable without moving the market. Defaults to 0 = off (a brand-new
   *  guardrail — untouched changes nothing). LIVE + PAPER equity only; options
   *  already gate on their own OI/volume floors, and a backtest doesn't set it. */
  maxAdvParticipationPct: number;
  /** Conviction-grade score thresholds (2026-07-24): every autotrade entry is
   *  stamped with a grade from its screener total score — A at/above
   *  `convictionGradeAMinScore`, B at/above `convictionGradeBMinScore`, else C.
   *  The grade is metadata that enriches the Journal's per-grade report and (behind
   *  a separate flag) can drive expectancy-weighted sizing. Grading is always on;
   *  only the sizing that reads it is gated. */
  convictionGradeAMinScore: number;
  convictionGradeBMinScore: number;
  /** Expectancy-weighted sizing (2026-07-24, services/autotrading/expectancySizing.ts).
   *  When on, each conviction grade's OWN realized average R shifts new-position
   *  size around baseline (`multiplier = clamp(1 + avgR, min, max)`), stacking
   *  with the other sizing multipliers. A grade with fewer than
   *  `expectancyMinTrades` closed trades stays neutral (1×). Off by default; the
   *  aggregate-open-risk veto still binds regardless. LIVE + PAPER only (each on
   *  its own book's edge) — a backtest has no realized per-grade history. */
  expectancyWeightingEnabled: boolean;
  expectancyMinTrades: number;
  expectancyMinMultiplier: number;
  expectancyMaxMultiplier: number;
  /** Method-weighted sizing (2026-08-21) — the same realized-edge lean as
   *  expectancy weighting, sliced by METHOD (long stock / short stock / calls
   *  / puts) instead of conviction grade, over each method's most recent
   *  closed trades. Shares the expectancyMinTrades sample floor and the
   *  expectancyMin/MaxMultiplier clamps (one lean dial, two axes). Leans,
   *  never switches: every method keeps trading — an unproven one at 1×, a
   *  bleeding one down toward the min clamp. See
   *  services/autotrading/methodSizing.ts. Off by default. */
  methodWeightingEnabled: boolean;

  // --- Screening/decision thresholds (docs/AUTOTRADING_SPEC.md — RESEARCH &
  // SCREEN / DECISION). Same treatment, extraction, and reasoning as the
  // risk-check parameters above, added 2026-07-11: these lived as hardcoded
  // constants (screen.ts's defaultAutotradeScreenerConfig(),
  // executionGuards.ts's defaultVolatilityFilterConfig(), decide.ts's
  // defaultDecisionConfig(), loop.ts's SESSION_BUFFER_MINUTES) with no way to
  // tune them at all — a structurally different category from the risk-check
  // fields (these gate what counts as a candidate and how it's priced, not
  // how a signal is sized/capped once found). Defaults below match those
  // constants exactly, so an untouched config's behavior doesn't change.
  // loop.ts threads these through explicitly on every tick; the manual
  // Screen/Decision preview routes (routes/autotrade.ts) default to them too
  // (so the preview matches what the loop would actually do) but can still
  // be overridden ad hoc per request, same convention as before. Backtesting
  // keeps using screen.ts's/decide.ts's own static legacy defaults unless a
  // request explicitly overrides via its existing screenerConfig/
  // decisionConfig fields — mirrors the risk-check fields' own backtest
  // treatment exactly. maxTickerAtrPct/maxMarketAtrPct/sessionBufferMinutes
  // have no backtest equivalent at all (a historical daily-bar replay has no
  // real-time session clock or same-day volatility guard to simulate).

  /** 'long' | 'short' | 'both' — see TradeDirectionMode's own doc comment.
   *  Defaults 'long', identical behavior to every config that predates this
   *  field. */
  tradeDirection: TradeDirectionMode;
  /** Screener's relative-volume floor (× average volume) — auto-trade leans
   *  harder on "unusual volume" than the manual screener's general-purpose
   *  default. 0 disables this specific filter (every relative-volume reading
   *  passes). */
  minRelVol: number;
  /** Screener's minimum share price (2026-07-27) — previously stuck at the
   *  engine's hardcoded $1, which let sub-$3 movers through, where the
   *  bid-ask spread is a large fraction of the ATR stop distance and live
   *  fills routinely lose beyond the declared stop (measured on the live
   *  book: ~20% of all losses were incurred past the stop, concentrated in
   *  exactly these names — a friction tax the zero-cost backtester never
   *  shows). 0 disables. Default 1 = the engine's old constant, so an
   *  untouched config changes nothing. */
  minPrice: number;
  /** Screener's minimum ~20-day average daily volume (shares) — the other
   *  half of the liquidity floor above. 0 disables. Default 200000 = the
   *  engine's old constant. */
  minAvgVolume: number;
  /** Whether the screen's discovery unions Webull's premarket movers
   *  (unusual volume + gainers) into the candidate set (2026-07-27).
   *  Previously hardwired ON whenever Webull was configured — there was no
   *  way to run a universe-only loop without unplugging Webull entirely
   *  (which live trading needs). OFF = the loop trades only the curated
   *  `universe` list; movers auto-promotion naturally goes quiet too, since
   *  it only ever considers movers-sourced candidates. Default true —
   *  untouched configs keep discovering movers exactly as before. */
  moversDiscoveryEnabled: boolean;
  /** Minimum weighted TOTAL screener score (0-100) a candidate must reach to
   *  pass screening (2026-07-26) — the conviction gate. Before this existed,
   *  the score only sorted candidates and stamped the A/B/C grade; a symbol
   *  scoring 3 that cleared the raw filters traded exactly like one scoring
   *  90 whenever the day was thin. Threaded into ScreenerFilters.minScore for
   *  the loop and the manual Screen/Decision previews alike (a backtest can
   *  apply the same gate via its screenerConfig.filters.minScore override).
   *  0 (the default) disables — an untouched config's behavior is unchanged.
   *  The conviction-grade thresholds (convictionGradeBMinScore, 60 by
   *  default) are a natural starting point: "only trade B-grade or better." */
  minSignalScore: number;
  /** Multi-timeframe confirmation (2026-07-16, docs/AUTOTRADING_SPEC.md
   *  phase 19): require price to ALSO be aligned with the chosen direction
   *  relative to its WEEKLY moving average, on top of whatever the daily
   *  setup already says — mirrors ScreenerFilters.requireWeeklyTrendAlignment
   *  (see its own doc comment for the fail-closed semantics and why it
   *  reuses maShort's period rather than a new one). Defaults `false` — an
   *  untouched config changes nothing. Unlike maxTickerAtrPct/maxMarketAtrPct
   *  above, this DOES have backtest support (all three engines fetch a
   *  parallel weekly history when it's enabled) — historical weekly bars are
   *  ordinary OHLCV data the existing Polygon-backed fetch already handles,
   *  not a live-only real-time reading. */
  requireWeeklyTrendAlignment: boolean;
  /** Relative-strength-vs-benchmark (2026-07-17): weight (0-100, same scale
   *  as every other indicators/screener.ts component) given to how much a
   *  candidate has out/under-performed benchmarkSymbol over
   *  relativeStrengthLookbackDays trading days — direction-aware, like every
   *  other component (a LONG candidate scores higher for BEATING the
   *  benchmark, a SHORT candidate scores higher for LAGGING it). 0 (the
   *  default) disables the component entirely — screen.ts doesn't even fetch
   *  the benchmark's own candles when this is 0, so an untouched config pays
   *  no extra provider call and changes nothing about existing scores. */
  relativeStrengthWeight: number;
  /** Symbol the relativeStrength component measures out/under-performance
   *  against — e.g. 'SPY'. Only matters when relativeStrengthWeight is
   *  nonzero. */
  benchmarkSymbol: string;
  /** Trading days back for both the candidate's own and the benchmark's
   *  lookback return that relativeStrengthWeight scores. */
  relativeStrengthLookbackDays: number;
  /** News-headline sentiment (2026-07-18): weight (0-100, same scale as
   *  every other indicators/screener.ts component) given to a simple,
   *  transparent keyword count over each candidate's recent headlines
   *  (services/sentiment.ts's computeHeadlineSentiment() — a small, fixed,
   *  documented word list, not a third-party sentiment API or ML model, to
   *  keep this explainable per this app's own scoring invariant). 0 (the
   *  default) disables the component entirely — screen.ts doesn't even
   *  fetch headlines when this is 0, so an untouched config pays no extra
   *  provider call and changes nothing about existing scores. Direction-
   *  aware like every other component: a LONG candidate scores higher for
   *  net-POSITIVE headlines, a SHORT candidate for net-NEGATIVE ones. */
  sentimentWeight: number;
  /** Skip a candidate whose own ATR% (of price) exceeds this — the loop's
   *  own per-ticker volatility guard, stricter than what the human-reviewed
   *  manual Screen/Decision preview applies (executionGuards.ts's header
   *  comment on why: an unattended loop has no one to override a bad read). */
  maxTickerAtrPct: number;
  /** Skip ALL new entries this cycle if the broad-market proxy's (SPY) own
   *  ATR% exceeds this. */
  maxMarketAtrPct: number;
  /** Stop distance = this × the candidate's own ATR. */
  stopAtrMultiple: number;
  /** Hard ceiling on stop distance as a % of entry price. 0 = off.
   *  stopAtrMultiple x ATR uses the DAILY ATR, so a 1.5x stop sits one and a
   *  half typical DAYS from entry — right for a swing, wrong for a loop that
   *  scratches at 90 minutes and is flat by the close. On 2026-08-25 MRNA's
   *  stop landed 14.6% away, costing $22.55 of risk PER SHARE against a $45.67
   *  budget (1 share), with a target 14.4% out that a session could not reach;
   *  it actually traded -1.15% / +3.42% after entry. Capping the stop shrinks
   *  risk-per-share, so the same risk budget buys a real position, AND fixes
   *  the target for free — the target is a multiple of the stop distance.
   *  See services/autotrading/decide.ts's clampStopDistance(). */
  maxStopDistancePct: number;
  /** LIVE scale-out (services/autotrading/scaleOut.ts): bank partialExitPct of
   *  a live equity position once it reaches partialExitRMultiple, by REDUCING
   *  the resting bracket legs to the remainder and then selling the difference.
   *  Off by default and behind its own flag on purpose — partialExitRMultiple
   *  has been 1.5 since the paper-only implementation, so reusing it alone
   *  would have switched live scale-outs on the moment this deployed. */
  liveScaleOutEnabled: boolean;
  /** LIVE stop ratchet (services/autotrading/stopAdjust.ts): let
   *  breakevenTriggerRMultiple / trailStartRMultiple / trailStopRMultiple move
   *  the stop on a LIVE equity position, by REPLACING the resting bracket's
   *  STOP_LOSS leg at the broker. Before this those three settings ran in the
   *  paper path only — they read as active in the UI while a live position
   *  kept one fixed stop for life.
   *
   *  Off by default and behind its own flag for the same reason
   *  liveScaleOutEnabled has one, and it is not a hypothetical here: all three
   *  are ALREADY non-zero in production (1 / 1 / 1.5), so wiring them straight
   *  through would have armed trailing stops on real money the moment this
   *  deployed, with nobody having chosen that. */
  liveTrailingEnabled: boolean;
  /** Day-protective stop (services/autotrading/stopAdjust.ts): once the
   *  give-back guard is ARMED, tighten a live position's stop just enough that
   *  a stop-out cannot drop the day below giveBackFloorPct — and no further.
   *
   *  Not a breakeven stop, on purpose. Breakeven scratches every trade that
   *  dips and recovers; this moves the stop only when the CURRENT one would
   *  breach the floor, and only as far as the floor requires, so on a normal
   *  day it does nothing at all. See the module header for the trade that
   *  motivated it. Off by default: it changes where real stops sit. */
  dayProtectiveStopEnabled: boolean;
  /** Master gate for the short-dated (0-2 DTE) options path — docs/SHORT_DATED_OPTIONS_SPEC.md. Off by default: it changes which contracts are bought AND how they are exited, and every parameter below is a Black-Scholes estimate rather than a measured value. */
  shortDatedOptionsEnabled: boolean;
  /** Hard flatten this many minutes before the 16:00 ET close. 120 = 14:00. Past roughly there a CORRECT thesis stops paying: a 0DTE whose underlying moved +1% is +15% at 13:30 and -15% at 14:30. Outranks every other exit rule. 0 disables. */
  optionsHardExitMinutesBeforeClose: number;
  /** No new short-dated entries this many minutes before the close. 210 = 12:30 — a contract opened later has too little time for the move to arrive against a steepening decay headwind. 0 disables. */
  optionsNoEntryMinutesBeforeClose: number;
  /** Stop when the UNDERLYING moves this % against the position. The real stop for a short-dated contract: time-invariant, where a percentage of a decaying premium is not (a flat tape alone costs 11% by 10:30 and 63% by 13:30). 0 disables. */
  optionsUnderlyingStopPct: number;
  /** Arm the give-back trail once the premium has been up at least this %. Below it a retrace is noise rather than a fade. */
  optionsGiveBackArmPct: number;
  /** Once armed, exit if the position gives back this % of its PEAK gain. Unrealised gain on a 0DTE is perishable — a +62% winner that retraces half its underlying move is -9%. */
  optionsGiveBackPct: number;
  /** Cut a short-dated position that has not started working within this many minutes. Reverses stagnationExit.ts's options exclusion on purpose: theta pricing the slot is mild at 30 DTE and the dominant risk at 0DTE. 0 disables. */
  optionsStagnationMinutes: number;
  /** The underlying move, in the position's favour, that counts as 'working' for the stagnation cut above. */
  optionsStagnationMinMovePct: number;
  /** Premium-percentage backstop for a gap or volatility collapse — NOT management. Deliberately wide: at anything tighter, ordinary decay fires it with no adverse move at all. 0 disables. */
  optionsDisasterStopPct: number;

  /** Target distance = stop distance × this (a reward:risk multiple). */
  targetRMultiple: number;
  /** No new entries within this many minutes of the session open or close —
   *  the opening auction and closing imbalance both distort prices in ways a
   *  signal shouldn't react to. */
  sessionBufferMinutes: number;
  /** Skip an EQUITY candidate whose next known earnings date falls within
   *  this many calendar days (today counts as day 0) — an unattended loop
   *  has no way to react to an earnings-driven overnight gap the way stop-
   *  loss sizing assumes. 0 (default) disables this check. Options entries
   *  are NOT gated by this — see docs/AUTOTRADING_SPEC.md's 2026-07-03
   *  resolved decision on why an approaching print already shows up as
   *  elevated IV rank there. An unknown earnings date (fetch failed, or
   *  Yahoo has nothing for this symbol) does NOT block — unlike the real-
   *  estate exclusion's fail-closed "unknown = skip," this check is a risk-
   *  reduction nice-to-have, not a compliance rule, and the underlying
   *  lookup (services/events.ts) is far more likely to be rate-limited or
   *  momentarily unavailable than the 30-day-cached sector classification
   *  is — failing closed here would silently starve the loop of candidates
   *  during ordinary Yahoo flakiness. */
  earningsBlackoutDays: number;
  /** RELATIVE-VOLUME PACE floor (indicators/relVolPace.ts): a multiple of the
   *  universe's MEDIAN relVolume this screen tick. Raw relVolume is today's
   *  cumulative volume over the average FULL-day volume, so it climbs through
   *  the session and a fixed floor on it is wrong at every hour but one — at
   *  10:47 ET on 2026-08-25 the median symbol read 0.10 and exactly one of 261
   *  reached 1.0. Dividing by the median makes "1.5x the market's current pace"
   *  mean the same thing at any hour, and cancels market-wide quiet/busy days.
   *  0 = off (raw minRelVol alone). */
  minRelVolPace: number;
  /** Minimum move TODAY in the trade's direction, % (a long needs +this, a
   *  short -this). 0 = off. The screener is largely POSITIONAL — momentum
   *  averages today's change with distance from both MAs, and `trend` scores
   *  the same MA relationship again, so where a stock sits after weeks of trend
   *  outweighs whether it is moving now by roughly 35 to 10. On 2026-08-25 IT
   *  was DOWN 3.45% on the day, scored 71.8 for momentum off its +9%/+28% MA
   *  distances, was bought long as a "breakout" and closed at -$23.94. */
  minChangePct: number;
  /** Score momentum from TODAY'S move alone, leaving price-vs-MA to the `trend`
   *  component that already measures it (indicators/screener.ts's
   *  scoreMomentum). Intended for an intraday loop, where last month's average
   *  is not the question. */
  momentumIntradayOnly: boolean;

  /** Scheduled macro-event blackout (2026-07-18): hard-block new entries,
   *  paper AND live, within this many hours (either side) of any date-time on
   *  the hand-maintained macro-events list (db/macroEvents.ts) — market-wide,
   *  unlike earningsBlackoutDays above, so it's checked once per loop tick
   *  (executionGuards.ts's checkMacroEventBlackout), the same gating point as
   *  the session-window check, not per-candidate inside the screener. 0 (the
   *  default) disables it entirely. No backtest equivalent — same documented
   *  scope boundary as sessionBufferMinutes/regime sizing/relative strength:
   *  a historical macro-event-date archive doesn't exist, so there's nothing
   *  for a backtest to replay this against. */
  macroEventBlackoutHours: number;

  // --- Max hold time (docs/AUTOTRADING_SPEC.md — RESOLVED DECISIONS, added
  // 2026-07-11). Unlike its neighbors above, this DOES have a backtest
  // equivalent (a daily-bar replay can track "days since entry" same as wall-
  // clock time) — see backtest.ts's own maxHoldDays handling. -----------------

  /** Force-close a position that's been open this many CALENDAR days without
   *  its stop or target firing — a backstop against a position that's just
   *  drifting sideways forever. 0 disables this check (hold until stop/
   *  target/manual close, same as before this existed). Applies to paper,
   *  live, and backtest equity positions alike; has no effect on options
   *  (which already force-close via its own separate time-exit). */
  maxHoldDays: number;

  // --- Trailing stop / breakeven / partial profit-taking (docs/
  // AUTOTRADING_SPEC.md — RESOLVED DECISIONS, added 2026-07-11). Originally
  // PAPER and BACKTEST equity only, because modifying or partially closing a
  // resting live bracket had no precedent here and a worse failure mode than
  // maxHoldDays' own live force-close. That precedent now exists, and all
  // three reach LIVE equity too — each behind its own flag, since these values
  // were long since set for the paper path and must not arm real-money
  // behaviour merely by being non-zero:
  //   - partialExitRMultiple / partialExitPct -> liveScaleOutEnabled
  //     (services/autotrading/scaleOut.ts, 2026-08-25)
  //   - breakevenTriggerRMultiple / trailStartRMultiple / trailStopRMultiple
  //     -> liveTrailingEnabled (services/autotrading/stopAdjust.ts, 2026-08-26)
  // All five still default to 0/disabled, so an untouched config's behavior
  // doesn't change. R-multiples here are measured against the position's
  // OWN original stop distance (fixed at entry), never a value that moves
  // as the stop itself ratchets. ---------------------------------------------

  /** Once unrealized gain reaches this many R, move the stop to exactly the
   *  entry price (breakeven) — a one-time ratchet, never applied if it would
   *  LOOSEN the current stop. 0 disables it. */
  breakevenTriggerRMultiple: number;
  /** Once unrealized gain reaches this many R, begin trailing the stop (see
   *  trailStopRMultiple) behind the best price seen since entry. 0 disables
   *  trailing entirely — breakevenTriggerRMultiple above works independently
   *  of this. */
  trailStartRMultiple: number;
  /** Once trailing is active, the stop trails this many R (in the
   *  position's own original risk-distance terms, i.e. × |entry − original
   *  stop|) behind the best price seen since entry — ratcheting only
   *  favorably, same as breakevenTriggerRMultiple. Meaningless if
   *  trailStartRMultiple is 0. */
  trailStopRMultiple: number;
  /** Once unrealized gain reaches this many R, close partialExitPct% of the
   *  position once — the rest keeps running toward its original target (or
   *  continues trailing). 0 disables it. */
  partialExitRMultiple: number;
  /** % of the position closed at the partialExitRMultiple trigger. Only
   *  meaningful when partialExitRMultiple is nonzero. */
  partialExitPct: number;
  /** Scale into winners (pyramiding): once unrealized gain reaches this many R
   *  — measured from the position's CURRENT (blended) entry against its frozen
   *  original per-share risk — add addOnSizePct% more shares, up to maxAddOns
   *  times. Each add blends the entry up (long) / down (short), shifts the
   *  recorded initial-stop level by the same amount so the R denominator stays
   *  the original per-share risk, and RAISES the protective stop to 1R below
   *  (long) / above (short) the new blended entry — never loosening it. 0
   *  disables scaling in entirely. PAPER + BACKTEST equity only (LIVE is
   *  untouched); mutually exclusive with a partial exit in the same cycle. */
  addOnTriggerRMultiple: number;
  /** Size of each add-on as a % of the position's CURRENT quantity. Only
   *  meaningful when addOnTriggerRMultiple and maxAddOns are both nonzero. */
  addOnSizePct: number;
  /** Hard cap on how many times a single position may be scaled into. 0
   *  disables scaling in (same as addOnTriggerRMultiple = 0). Bounds how
   *  top-heavy a pyramid can get. */
  maxAddOns: number;

  // --- Correlation methodology (docs/AUTOTRADING_SPEC.md — RESOLVED
  // DECISIONS). Formerly riskProfiles.ts's CORRELATION_LOOKBACK_DAYS/
  // CORRELATION_THRESHOLD — that file's entire remaining purpose was these
  // two constants, so it's deleted now that they've moved here too (added
  // 2026-07-11, same day/reasoning as the screening/decision thresholds
  // above). Unlike maxCorrelatedExposurePct (the % cap this feeds into),
  // these govern HOW correlation is measured, not a risk-tolerance dial —
  // still tunable, just a different kind of knob. Defaults match the old
  // constants exactly. -------------------------------------------------------

  /** Trading days of daily-return history compared when measuring
   *  correlation between two symbols. */
  correlationLookbackDays: number;
  /** |Pearson r| at or above this counts as "correlated" for
   *  maxCorrelatedExposurePct's purposes. 0-1, not a percentage. */
  correlationThreshold: number;
  /** Correlation-aware candidate selection (2026-07-24, default OFF). When on,
   *  the score-sorted candidate list is re-ranked before the decision stage so
   *  that among names correlated at ≥ correlationThreshold, the higher-scored
   *  one keeps its rank and the redundant lower one is demoted to the back —
   *  diverse picks win the caps instead of a correlated huddle. Reuses
   *  correlationThreshold / correlationLookbackDays; reorders only, never drops
   *  (the exposure veto stays the backstop). Applies to live, paper, and the
   *  backtest engines. */
  correlationAwareSelectionEnabled: boolean;

  // --- Regime-conditional scoring weights (2026-07-24) -----------------------

  /** Regime-adaptive screener weights (default OFF). When on, the loop computes
   *  the market regime (services/marketRegime.ts — SPY proxy, cached ~1h) at
   *  scoring time and applies the matching `regimeWeightPresets` entry instead
   *  of the fixed default weights, so the strategy re-weights what it rewards to
   *  the environment (e.g. lean on trend in risk-on, on mean-reversion/RSI in
   *  risk-off). Off = today's fixed weights exactly. `relativeStrength` /
   *  `sentiment` always stay driven by their own weight fields below,
   *  regardless — the presets only govern the six core weights. */
  regimeAdaptiveWeightsEnabled: boolean;
  /** Per-regime screener weight sets, selected by the gauge's risk-on / neutral
   *  / risk-off label when regimeAdaptiveWeightsEnabled is on. Each defaults to
   *  the standard screener weights, so enabling with untouched presets changes
   *  nothing until a preset is actually edited. */
  regimeWeightPresets: RegimeWeightPresets;

  // --- Phase 8: live-trading gate (docs/AUTOTRADING_SPEC.md) -----------------

  /** Master on/off for the loop placing REAL orders through Webull. False by
   *  default. Paper execution (execute.ts, autotrade_paper_positions) is
   *  completely independent of this flag and keeps running either way — this
   *  only gates the separate live path (Phase 8 Step B). Setting this false
   *  -> true requires the exact confirmLiveTrading phrase at the route
   *  (routes/autotrade.ts) — confirmed decision: a one-time, deliberate
   *  gesture per enable, not per-order friction. */
  liveTradingEnabled: boolean;
  /** Epoch ms of the most recent false -> true transition of
   *  liveTradingEnabled, or null if never enabled. Anchors the probation
   *  window (liveProbationTrades): how many trades count as "still in
   *  probation" is DERIVED from real order_intents created at/after this
   *  timestamp (Step B), never a separately-incremented counter that could
   *  drift from what was actually placed. */
  liveEnabledAt: number | null;
  /** The Webull cash account_id the live loop places orders against —
   *  server-side only. The human Trade page sources its accountId from
   *  browser localStorage, which has no meaning for an unattended process;
   *  this is set once here instead. Live trading can't be enabled while this
   *  is unset (fails closed, same posture as accountEquityUsd). */
  liveAccountId: string | null;
  /** Guardrail caps for autotrade's OWN live orders (services/trading/
   *  guardrails.ts's evaluateGuardrails(), called with this config instead of
   *  db/trading.ts's human-tuned TradingConfig) — deliberately a separate cap
   *  set, since autotrade sizes risk-based (% equity × stop distance), which
   *  can imply a different notional than the human page's flat caps were
   *  tuned around. See suggestLiveCaps() for the equity-derived starting
   *  formula; freely editable afterward. */
  liveMaxOrderUsd: number;
  liveMaxDailyLossUsd: number;
  liveMaxOrdersPerDay: number;
  liveFatFingerPct: number;
  /** Defaults false, matching guardrails.ts's own default and this project's
   *  defined-risk-by-default posture. */
  liveAllowNakedShort: boolean;
  /** How many live trades (counted from liveEnabledAt) get an extra
   *  liveProbationSizeMultiplier size cut on top of the risk profile's normal
   *  sizing and any loss-streak step-down already active (Phase 8 Step B). */
  liveProbationTrades: number;
  liveProbationSizeMultiplier: number;
  /** Scale into winners on LIVE equity positions — a plain opt-in nested UNDER
   *  liveTradingEnabled (same relationship liveOptionsEnabled has to the master
   *  gate). The autotrade loop only pyramids a live position when BOTH this and
   *  liveTradingEnabled are true (and the shared addOnTriggerRMultiple /
   *  addOnSizePct drive the WHEN/how-much, same as paper). Defaults false — this
   *  is the one live setting that ADDS risk to an already-open real position, so
   *  it's off until deliberately turned on. Each add is placed as its OWN
   *  bracket (raised stop + the position's target), so the added shares are
   *  never naked and the original bracket is never touched. */
  liveScaleInEnabled: boolean;
  /** Hard cap on live pyramids per position — can be set LOWER than the paper
   *  maxAddOns for extra caution on real money. 0 disables live scaling in
   *  entirely regardless of liveScaleInEnabled. */
  liveMaxAddOns: number;

  // --- Task #70: live options trading -----------------------------------

  /** Options-specific opt-in nested UNDER liveTradingEnabled — the master
   *  gate (and its typed confirmation phrase) already covers "real money is
   *  now live"; this is a plain checkbox with no second confirmation, same
   *  relationship optionsStrategyType already has to the paper loop's own
   *  master `enabled` toggle. The loop only places live OPTIONS orders when
   *  BOTH this and liveTradingEnabled are true. Reuses liveAccountId (already
   *  asset-agnostic — Webull returns one account for both stock and option
   *  orders) rather than a second account id field. */
  liveOptionsEnabled: boolean;
  /** Epoch ms of the most recent false -> true transition of
   *  liveOptionsEnabled, or null if never enabled. Anchors the OPTIONS
   *  probation window separately from liveEnabledAt: a user could enable live
   *  EQUITY trading first and only turn on live OPTIONS weeks later, so the
   *  options probation window should start when OPTIONS specifically went
   *  live, not when the master flag did. */
  liveOptionsEnabledAt: number | null;
  /** Guardrail caps for autotrade's own LIVE OPTIONS orders — dedicated,
   *  separate from the live EQUITY caps above (liveMaxOrderUsd etc.), mirroring
   *  how paper trading already keeps the two books' risk separate-but-combined.
   *  Options position sizing (premium-based, defined-risk by strike
   *  construction) is a different shape than equity's share-count sizing, so
   *  tuning these independently is deliberate, not an oversight. */
  liveOptionsMaxOrderUsd: number;
  liveOptionsMaxDailyLossUsd: number;
  liveOptionsMaxOrdersPerDay: number;
  /** The equity the four equity-scaled DOLLAR caps (liveMaxOrderUsd /
   *  liveMaxDailyLossUsd and their options twins) were last derived from.
   *  Written by a "tune from target" apply (targetTune.ts stamps it into the
   *  patch) and by each automatic re-anchor; null = re-anchoring disarmed.
   *
   *  Why it exists: the percent caps re-scale themselves (accountEquityUsd is
   *  synced from the broker every loop tick), but a stored dollar figure is
   *  frozen at whatever equity it was computed from — as the account grows it
   *  quietly tightens, and as the account shrinks it quietly LOOSENS, relative
   *  to the tune's intent. liveCapsReanchor.ts re-derives the four dollar caps
   *  from current equity when it has drifted ≥15% from this anchor, touching
   *  only caps that still match their anchor-derived value (a hand-edited cap
   *  is the user's, and stays theirs). */
  liveCapsAnchorEquityUsd: number | null;
  /** The DAILY GAIN GOAL, as a % of the day's starting account value — the
   *  live half of "tune from target" (targetTune.ts calibrates sizing from it;
   *  dailyTarget.ts tracks it during the session). Stamped by every tune
   *  apply. While set, the loop halts NEW live entries and scale-ins for the
   *  rest of the ET day once synced equity reaches
   *  dayStartEquity × (1 + this/100) — bank the day, then start fresh on the
   *  next day's value (daily compounding of the goal, not of the risk).
   *  Null = no goal tracking (the tune is calibration only, pre-2026-08 behavior). */
  targetDailyGainPct: number | null;
  /** GIVE-BACK GUARD arm level, as a day-gain % of the day-start value: once
   *  the day has been up at least this much, the guard arms — protect the
   *  almost-banked day (services/autotrading/dailyTarget.ts). Stamped by a
   *  tune at ~2/3 of targetDailyGainPct. Null (or no floor below) = guard off. */
  giveBackArmPct: number | null;
  /** GIVE-BACK GUARD floor: after arming, if the day's gain falls back to
   *  this % or lower, NEW live entries and scale-ins halt for the rest of the
   *  ET day (sticky, same as a reached target — exits/paper keep running).
   *  Keeps most of a good day instead of letting the loop trade it back to
   *  flat. Stamped by a tune at ~1/3 of targetDailyGainPct; must sit below
   *  giveBackArmPct or the guard stays off. */
  giveBackFloorPct: number | null;
  /** SYMBOL LOSS COOLDOWN (services/autotrading/symbolCooldown.ts): once a
   *  symbol has taken this many LOSING closed live trades within the trailing
   *  symbolCooldownWindowDays calendar days, its new LIVE entries (stock and
   *  options) are skipped until symbolCooldownDays after the last loss. 0 or
   *  1 = off (single-loss re-entries have won — the feature exists for
   *  REPEATED losses). Paper keeps trading the name as the evidence track. */
  symbolCooldownLosses: number;
  symbolCooldownWindowDays: number;
  symbolCooldownDays: number;
  /** FINISH-LINE SIZING (services/autotrading/finishLine.ts): when the
   *  remaining gap to the daily bank line is smaller than a full-size
   *  winner's expected payoff, trim the next live entry's risk so its win
   *  lands the day at the goal (floored at quarter size; never sizes up). */
  finishLineSizingEnabled: boolean;
  /** SELECTIVITY RAMP: minimum signal score for new live entries while the
   *  give-back guard is ARMED — the trades most likely to give an
   *  almost-banked day back are held to a higher conviction bar. 0 = off;
   *  needs the guard levels set (it rides the guard's arm flag). */
  finishLineMinSignalScore: number;
  /** INTRADAY STAGNATION EXIT (services/autotrading/stagnationExit.ts): a
   *  live equity position that has made less than stagnationExitMinR of R
   *  progress after this many wall-clock minutes (evaluated only while the
   *  regular session is open) is scratched via the time-exit path, freeing
   *  its concurrent-position slot and open-risk budget for fresh signals.
   *  0 = off. Positions with no stop are never scratched (no R to measure). */
  stagnationExitMinutes: number;
  /** The R-progress bar for the stagnation exit above: below this after the
   *  deadline = recycled. May be 0 ("scratch only if not even at breakeven
   *  progress"); a slow bleeder below 0R is recycled too. */
  stagnationExitMinR: number;
  /** END-OF-DAY FLATTEN (services/autotrading/endOfDayFlatten.ts): inside the
   *  last N minutes of the regular session, close every open LIVE EQUITY
   *  position at a marketable limit rather than carrying it overnight —
   *  regardless of progress or hold time, so a WORKING trade is flattened too
   *  (the decision is about the clock, not the trade). Also replaces a resting
   *  exit order placed before the window, which may be nowhere near the current
   *  price. 0 = off. This loop's edge is intraday, so an overnight hold is
   *  unhedged gap exposure the strategy never intended to take. */
  endOfDayFlattenMinutes: number;
  /** LEVEL-AWARE EXITS (services/autotrading/levelPlan.ts). When on, a LIVE
   *  equity signal's ATR stop and R target are re-placed against real swing
   *  structure before the risk check sees them: the stop widens to clear the
   *  nearest support/resistance instead of resting inside it, the target is
   *  capped short of the opposing wall instead of being priced through it,
   *  and a setup whose reachable reward falls under levelMinRewardR is
   *  rejected outright. Off = the ATR plan stands, exactly as before. */
  levelExitsEnabled: boolean;
  /** Minimum level strength (0..1) before structure may move an exit or block
   *  a trade — a lone stale touch is not a wall. */
  levelMinStrength: number;
  /** Clearance beyond a level, as a % of price, for both stop and target. */
  levelBufferPct: number;
  /** Cap on stop widening, as a % of the original ATR stop distance. */
  levelMaxStopWidenPct: number;
  /** Reject a setup whose capped target is worth less than this in R. 0 caps
   *  targets but never refuses a trade. */
  levelMinRewardR: number;
  liveOptionsFatFingerPct: number;
  /** Mirrors liveProbationTrades/liveProbationSizeMultiplier, counted from
   *  liveOptionsEnabledAt via countLiveOptionsOrdersSince() — a fully
   *  separate probation window from equity's own. */
  liveOptionsProbationTrades: number;
  liveOptionsProbationSizeMultiplier: number;

  // --- Options strategy shape (docs/AUTOTRADING_SPEC.md — phase 9/10 follow-up) ---

  /** 'single_leg' (default) or 'debit_spread' — see OptionsStrategyType doc
   *  comment above. Applies to both the paper-trading loop (loop.ts) and the
   *  /decide preview route (routes/autotrade.ts); backtesting is unaffected
   *  (options backtests remain single-leg only). */
  optionsStrategyType: OptionsStrategyType;

  // --- Options entry-rule thresholds (the contract-quality screen the
  // decision stage runs BEFORE risk-check ever sees a candidate — see
  // entryRules.ts's EntryStrategyConfig/scanEntries and optionsDecide.ts's
  // generateOptionsSignal). Previously fixed constants (entryRules.ts's
  // defaultEntryConfig() plus optionsDecide.ts's own ivRankMax:70 layered on
  // top) with no way to tune them — same treatment as the screening/decision
  // thresholds above: a candidate failing the 'delta band'/'max spread %'/
  // 'min open interest'/'min volume'/DTE/'IV rank' rule (entryRules.ts) could
  // only be reported, never adjusted. Defaults below match those constants
  // exactly, so an untouched config's behavior doesn't change. Threaded into
  // generateOptionsSignal() via OptionsDecisionConfig.entryConfig (an
  // override already merged onto defaultAutotradeEntryConfig(side) — see that
  // function's own doc comment) by loop.ts and the /decide preview route,
  // mirroring exactly how every other screening/decision field above is
  // wired in. Backtesting is unaffected — optionsBacktest.ts/
  // combinedBacktest.ts call defaultAutotradeEntryConfig() directly, same
  // self-contained-hypothesis convention as every other screening/decision
  // field's own backtest treatment. --------------------------------------

  /** Absolute delta band (0-1) a contract's |delta| must fall within. */
  optionsDeltaMin: number;
  optionsDeltaMax: number;
  /** Max (ask - bid) / mid, as a percentage of mid price. */
  optionsMaxSpreadPct: number;
  optionsMinOpenInterest: number;
  optionsMinVolume: number;
  optionsMinDte: number;
  optionsMaxDte: number;
  /** Underlying IV-rank ceiling (0-100) — this system only ever buys premium,
   *  so guarding against a high-IV underlying is the one direction that
   *  matters here. */
  optionsIvRankMax: number;
  /** Underlying IV-rank floor (0-100) — entryRules.ts's ivRankMin, which
   *  existed in the engine but was unreachable from config until 2026-07-27.
   *  0 (default) = no floor, byte-identical to the previous behavior. */
  optionsIvRankMin: number;
  /** Cheapness gate (2026-07-27): maximum ratio of the underlying's ATM
   *  implied vol to its 20-day realized vol for an options entry. Long
   *  premium pays a structural tax (the variance risk premium) whenever
   *  implied runs above realized; the evidence-backed "buy when cheap"
   *  signal is IV vs. REALIZED vol (Goyal–Saretto), not IV rank alone —
   *  IV rank only says where implied sits in its own range, not whether it
   *  overprices actual movement. ~1.0 means "implied no richer than
   *  realized"; 0 (default) disables the gate entirely. Applies to the
   *  paper/live decision stage AND (via optionsDecisionConfig.maxIvRvRatio)
   *  the options/combined backtests, so the gate can be tested before it's
   *  trusted. Fails closed: gate on + realized vol uncomputable = skip. */
  optionsMaxIvRvRatio: number;

  // --- Options stop-loss / take-profit (docs/AUTOTRADING_SPEC.md — follow-up
  // to phase 12's own confirmed close-only, time-based exit design; added
  // 2026-07-16). PAPER and BACKTEST options positions only, mirroring the
  // equity trailing-stop/breakeven/partial-exit fields above — LIVE options
  // positions stay time-exit-only (see that section's own writeup: a resting
  // live position has no bracket to lean on and a meaningfully worse failure
  // mode than a scheduled time-based close). Reuses options/exitRules.ts's
  // own %-of-premium model (unrealized return vs. entry price, net debit for
  // a spread), not decide.ts's R-multiple one, since a long option/spread has
  // no ATR-based stop distance to measure R against. Both default to 0
  // (disabled), so leaving them untouched changes nothing — the loop stays
  // exactly as time-exit-only as it's always been. -----------------------

  /** Exit a paper/backtest options position once its unrealized loss reaches
   *  this % of the premium paid (net debit, for a spread). 0 disables it. */
  optionsStopLossPct: number;
  /** Exit a paper/backtest options position once its unrealized gain reaches
   *  this % of the premium paid (net debit, for a spread). 0 disables it. */
  optionsTakeProfitPct: number;

  // --- Options trailing stop / breakeven / partial profit-taking (added
  // 2026-07-17). PAPER and BACKTEST options positions only, same scope
  // boundary as optionsStopLossPct/optionsTakeProfitPct above — LIVE options
  // positions stay time-exit-only. The options counterpart to the equity
  // trailing-stop/breakeven/partial-exit fields above, adapted to options'
  // %-of-premium model (net debit, for a spread) instead of a price-based
  // stop: a long option/spread has no ATR-based stop distance to ratchet a
  // PRICE against, so these are expressed directly as percentage points of
  // unrealized gain, not R-multiples. All five default to 0/disabled except
  // optionsPartialExitPct (50), so leaving them untouched changes nothing.
  // ---------------------------------------------------------------------

  /** Once unrealized gain reaches this % of premium, lock in at least
   *  breakeven (0% gain) — a one-time ratchet, never applied if it would
   *  loosen the current floor. 0 disables it. */
  optionsBreakevenTriggerPct: number;
  /** Once unrealized gain reaches this %, begin trailing (see
   *  optionsTrailStopPct) behind the best gain % seen since entry. 0
   *  disables trailing entirely — optionsBreakevenTriggerPct above works
   *  independently of this. */
  optionsTrailStartPct: number;
  /** Once trailing is active, the floor trails this many percentage points
   *  behind the best unrealized gain % seen since entry — ratcheting only
   *  favorably, same as optionsBreakevenTriggerPct. Meaningless if
   *  optionsTrailStartPct is 0. */
  optionsTrailStopPct: number;
  /** Once unrealized gain reaches this %, close optionsPartialExitPct% of
   *  the position once — the rest keeps running toward its original
   *  take-profit (or continues trailing). 0 disables it. */
  optionsPartialExitTriggerPct: number;
  /** % of the position closed at the optionsPartialExitTriggerPct trigger.
   *  Only meaningful when that trigger is nonzero. */
  optionsPartialExitPct: number;

  // --- Movers auto-promotion (docs/AUTOTRADING_SPEC.md — the 2026-07-10
  // universe-widening fix's explicitly separate follow-up) ---------------

  /** Master on/off for promoting a recurring movers-sourced symbol into the
   *  persistent universe. Only ever runs from the automatic loop tick
   *  (services/autotrading/moversPromotion.ts, wired into loop.ts) — never
   *  from the manual "Run screen" route, since this addresses the AUTOMATED
   *  loop's own tendency to re-discover, then discard, the same genuinely
   *  active name every day. Defaults true: promotion can't fire until a
   *  symbol has accumulated autoPromoteThreshold days of history, so turning
   *  this on at deploy time carries no risk of an immediate mass-promotion. */
  autoPromoteMoversEnabled: boolean;
  /** A symbol needs this many DISTINCT calendar days as a movers-sourced,
   *  filters-passing screen candidate within autoPromoteWindowDays before
   *  it's promoted. */
  autoPromoteThreshold: number;
  /** Rolling calendar-day window autoPromoteThreshold is measured over. */
  autoPromoteWindowDays: number;
  /** Lifetime cap on symbols ADDED BY THIS MECHANISM specifically — doesn't
   *  count the seeded/user-added universe. Once a symbol is promoted (or a
   *  user removes a promoted symbol later), it's never reconsidered again
   *  either way: this is a one-shot "earn a permanent spot," not a rolling
   *  membership that could thrash. */
  autoPromoteMaxSymbols: number;

  // --- Auto-tune from realized edge (docs/AUTOTRADING_SPEC.md — 2026-07-18
  // follow-up). Off by default, an explicit opt-in mirroring every other
  // guardrail in this config — nothing here changes on its own unless this is
  // switched on. Once per (ET) trading day, not per-tick — realized-trade
  // stats don't move meaningfully inside a day, and re-deriving them every
  // 60s tick would be wasted work — see services/autotrading/autoTune.ts:
  //   - riskPerTradePct is nudged toward the Journal page's own Kelly
  //     suggestion (services/pnl.ts's kellySuggestion — same quarter-Kelly,
  //     3%-capped math already shown there), once there are enough decisive
  //     closed trades, by at most autoTuneMaxStepPct percentage points per
  //     day, so one noisy day can't swing live sizing on its own.
  //   - a symbol whose average live-fill slippage (services/slippage.ts)
  //     exceeds autoTuneSlippageExcludePct, over enough fills, gets added to
  //     the existing exclusion list (db/autotradeExclusions.ts) — the SAME
  //     list the real-estate/manual exclusions already use, so it's
  //     immediately visible and removable from Settings, not a separate
  //     hidden mechanism.
  // Every adjustment is journaled (autotrade_events), so it shows up on
  // Recent Activity the same as every other automated action this loop
  // takes — nothing here happens silently. ------------------------------------

  /** Master on/off for both behaviors above. */
  autoTuneEnabled: boolean;
  /** Decisive closed trades (for the risk-% tune) / live fills with a
   *  comparable limit price (for the slippage exclusion) required before
   *  auto-tune trusts a reading enough to act on it — defaults to 20,
   *  matching kellySuggestion's own existing reliable-sample-size floor, so
   *  this doesn't invent a stricter or looser bar than the Journal page
   *  already uses for the same number. */
  autoTuneMinTrades: number;
  /** Max change to riskPerTradePct in a single day's adjustment (percentage
   *  points, not a %-of-current-value) — bounds how fast auto-tune can move
   *  live position sizing even if the Kelly suggestion itself jumps sharply
   *  between two runs. */
  autoTuneMaxStepPct: number;
  /** A symbol's average live-fill slippage (% of limit price, same signed
   *  convention as services/slippage.ts — positive always cost money) at or
   *  above this gets auto-excluded from future autotrade candidates. */
  autoTuneSlippageExcludePct: number;
  /** Exit-geometry auto-tune (2026-07-24, services/autotrading/excursionTune.ts).
   *  When on (and autoTuneEnabled), the same once-per-ET-day pass nudges
   *  stopAtrMultiple / targetRMultiple toward what WINNING autotrade trades
   *  actually did — a good trade's worst drawdown (MAE) sizes the stop, its
   *  favorable peak (MFE) sizes the target. Off by default; independent of the
   *  Kelly risk-% tune above so you can adopt one without the other. */
  autoTuneExitsEnabled: boolean;
  /** Max change to stopAtrMultiple or targetRMultiple in a single day's
   *  exit-tune (in multiple units, not a %), so one noisy sample can't swing
   *  the loop's exits — the exit-geometry analogue of autoTuneMaxStepPct. */
  autoTuneExitMaxStep: number;
  /** When the exit-geometry tuner last moved stopAtrMultiple/targetRMultiple.
   *  Server-owned bookkeeping (like liveEnabledAt) — not settable via the config
   *  route. Excursion is measured in R, i.e. against each trade's OWN stop at
   *  entry, so trades taken before a change can't tell you anything about the
   *  geometry that replaced them; the tuner uses this to ignore them and wait
   *  for fresh evidence. See services/autotrading/excursionTune.ts. */
  autoTuneExitTunedAt: number | null;
  /** Walk-forward guard on the Kelly risk-% auto-tune (2026-07-24, ON by
   *  default). When on, a risk-% INCREASE is only applied if the edge still
   *  holds out-of-sample — the most recent half of closed trades must be a
   *  reliable sample whose expectancy CI sits entirely above zero (see
   *  services/autotrading/significance.ts checkOosEdgeConfirmation). A decrease
   *  is always applied (the safe direction). Only matters when autoTuneEnabled;
   *  stops the tune from chasing an in-sample edge that hasn't held up. */
  autoTuneRequireOosConfirmation: boolean;
}

interface ConfigRow {
  config: string;
}

/** The exact phrase required to flip liveTradingEnabled false -> true (see
 *  routes/autotrade.ts) — a deliberate, one-time gesture per enable, not a
 *  per-order check. Case/whitespace-insensitive at the route, same
 *  normalization style as services/trading/placeOrder.ts's placeConfirmation. */
export const LIVE_TRADING_CONFIRMATION_PHRASE = 'ENABLE LIVE TRADING';

/** Independent of maxTradesPerDay below (a live-only broker guardrail, not
 *  the risk-check's own trade-count cap) — the two happen to share a default,
 *  not a dependency. */
const DEFAULT_LIVE_MAX_ORDERS_PER_DAY = 6;

export function defaultAutotradeConfig(): AutotradeConfig {
  return {
    enabled: false,
    killSwitch: false,
    riskProfile: 'MODERATE',
    accountEquityUsd: null,
    maxConcurrentPositions: 2,
    riskPerTradePct: 1,
    maxDailyDrawdownPct: 3,
    stepDownAfterLosses: 2,
    stepDownSizeCutPct: 50,
    maxAggregateOpenRiskPct: 2,
    maxCorrelatedExposurePct: 6,
    maxSectorExposurePct: 20,
    maxTradesPerDay: 6,
    regimeAtrThresholdPct: 3,
    regimeSizeCutPct: 0,
    equityCurveDeriskEnabled: false,
    equityCurveLookbackDays: 10,
    equityCurveDeriskCutPct: 50,
    maxAdvParticipationPct: 0,
    convictionGradeAMinScore: 75,
    convictionGradeBMinScore: 60,
    expectancyWeightingEnabled: false,
    methodWeightingEnabled: false,
    expectancyMinTrades: 10,
    expectancyMinMultiplier: 0.5,
    expectancyMaxMultiplier: 1.5,
    tradeDirection: 'long',
    minRelVol: 1.5,
    minPrice: 1,
    minAvgVolume: 200_000,
    moversDiscoveryEnabled: true,
    minSignalScore: 0,
    requireWeeklyTrendAlignment: false,
    relativeStrengthWeight: 0,
    benchmarkSymbol: 'SPY',
    relativeStrengthLookbackDays: 20,
    sentimentWeight: 0,
    maxTickerAtrPct: 15,
    maxMarketAtrPct: 5,
    stopAtrMultiple: 1.5,
    maxStopDistancePct: 0,
    liveScaleOutEnabled: false,
    liveTrailingEnabled: false,
    dayProtectiveStopEnabled: false,
    shortDatedOptionsEnabled: false,
    optionsHardExitMinutesBeforeClose: 120,
    optionsNoEntryMinutesBeforeClose: 210,
    optionsUnderlyingStopPct: 0.5,
    optionsGiveBackArmPct: 40,
    optionsGiveBackPct: 50,
    optionsStagnationMinutes: 30,
    optionsStagnationMinMovePct: 0.3,
    optionsDisasterStopPct: 70,
    targetRMultiple: 2,
    sessionBufferMinutes: 15,
    earningsBlackoutDays: 0,
    minRelVolPace: 0,
    minChangePct: 0,
    momentumIntradayOnly: false,
    macroEventBlackoutHours: 0,
    maxHoldDays: 0,
    breakevenTriggerRMultiple: 0,
    trailStartRMultiple: 0,
    trailStopRMultiple: 0,
    partialExitRMultiple: 0,
    partialExitPct: 50,
    addOnTriggerRMultiple: 0,
    addOnSizePct: 50,
    maxAddOns: 0,
    correlationLookbackDays: 30,
    correlationThreshold: 0.7,
    correlationAwareSelectionEnabled: false,
    regimeAdaptiveWeightsEnabled: false,
    regimeWeightPresets: {
      riskOn: { ...defaultScreenerConfig().weights },
      neutral: { ...defaultScreenerConfig().weights },
      riskOff: { ...defaultScreenerConfig().weights },
    },
    liveTradingEnabled: false,
    liveEnabledAt: null,
    liveAccountId: null,
    liveMaxOrderUsd: 500,
    liveMaxDailyLossUsd: 250,
    liveMaxOrdersPerDay: DEFAULT_LIVE_MAX_ORDERS_PER_DAY,
    liveFatFingerPct: 10,
    liveAllowNakedShort: false,
    liveProbationTrades: 20,
    liveProbationSizeMultiplier: 0.5,
    liveScaleInEnabled: false,
    liveMaxAddOns: 0,
    liveOptionsEnabled: false,
    liveOptionsEnabledAt: null,
    liveOptionsMaxOrderUsd: 500,
    liveOptionsMaxDailyLossUsd: 250,
    liveOptionsMaxOrdersPerDay: DEFAULT_LIVE_MAX_ORDERS_PER_DAY,
    liveCapsAnchorEquityUsd: null,
    targetDailyGainPct: null,
    giveBackArmPct: null,
    giveBackFloorPct: null,
    symbolCooldownLosses: 0,
    symbolCooldownWindowDays: 5,
    symbolCooldownDays: 3,
    finishLineSizingEnabled: false,
    finishLineMinSignalScore: 0,
    stagnationExitMinutes: 0,
    stagnationExitMinR: 0.5,
    endOfDayFlattenMinutes: 0,
    levelExitsEnabled: false,
    levelMinStrength: 0.35,
    levelBufferPct: 0.15,
    levelMaxStopWidenPct: 60,
    levelMinRewardR: 1,
    liveOptionsFatFingerPct: 10,
    liveOptionsProbationTrades: 20,
    liveOptionsProbationSizeMultiplier: 0.5,
    optionsStrategyType: 'single_leg',
    optionsDeltaMin: 0.3,
    optionsDeltaMax: 0.6,
    optionsMaxSpreadPct: 10,
    optionsMinOpenInterest: 100,
    optionsMinVolume: 10,
    optionsMinDte: 7,
    optionsMaxDte: 60,
    optionsIvRankMax: 70,
    optionsIvRankMin: 0,
    optionsMaxIvRvRatio: 0,
    optionsStopLossPct: 0,
    optionsTakeProfitPct: 0,
    optionsBreakevenTriggerPct: 0,
    optionsTrailStartPct: 0,
    optionsTrailStopPct: 0,
    optionsPartialExitTriggerPct: 0,
    optionsPartialExitPct: 50,
    autoPromoteMoversEnabled: true,
    autoPromoteThreshold: 3,
    autoPromoteWindowDays: 10,
    autoPromoteMaxSymbols: 50,
    autoTuneEnabled: false,
    autoTuneMinTrades: 20,
    autoTuneMaxStepPct: 0.5,
    autoTuneSlippageExcludePct: 2,
    autoTuneExitsEnabled: false,
    autoTuneExitMaxStep: 0.25,
    autoTuneExitTunedAt: null,
    autoTuneRequireOosConfirmation: true,
  };
}

/** Coerce a stored/patched config into a safe, complete AutotradeConfig. */
function sanitize(input: Partial<AutotradeConfig>): AutotradeConfig {
  const d = defaultAutotradeConfig();
  const equity =
    input.accountEquityUsd === null
      ? null
      : typeof input.accountEquityUsd === 'number' && input.accountEquityUsd > 0
        ? input.accountEquityUsd
        : d.accountEquityUsd;
  const nonNeg = (v: unknown, fallback: number) => {
    const n = Number(v);
    return Number.isFinite(n) && n >= 0 ? n : fallback;
  };
  const pct = (v: unknown, fallback: number) => {
    const n = Number(v);
    return Number.isFinite(n) ? Math.min(100, Math.max(0, n)) : fallback;
  };
  const posInt = (v: unknown, fallback: number) => {
    const n = Number(v);
    return Number.isFinite(n) && n >= 0 ? Math.floor(n) : fallback;
  };
  // At least 1 — unlike posInt, 0 isn't a valid "unlimited" or "off" reading
  // here; it would silently block every entry forever without the clarity of
  // the kill switch, which already exists for that.
  const posIntMin1 = (v: unknown, fallback: number) => {
    const n = Number(v);
    return Number.isFinite(n) && n >= 1 ? Math.floor(n) : fallback;
  };
  // A positive (non-zero), fraction-preserving number — like posIntMin1 but
  // keeps decimal precision (ATR/R multiples are routinely fractional, e.g.
  // 1.5× ATR), and unlike nonNeg/pct, 0 is never valid here: a zero stop
  // distance or zero-R target is meaningless, and this app requires a real
  // stop on every position.
  const posDecimal = (v: unknown, fallback: number) => {
    const n = Number(v);
    return Number.isFinite(n) && n > 0 ? n : fallback;
  };
  // A Pearson-r threshold, not a percentage — clamps to [0, 1] like pct()
  // clamps to [0, 100], same "clamp, don't reject" semantics.
  const unitInterval = (v: unknown, fallback: number) => {
    const n = Number(v);
    return Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : fallback;
  };
  // A screener weight set — coerce every known IndicatorKey to a non-negative
  // number, filling any missing/invalid key from the fallback (so a partial
  // preset from an older client, or one missing a newly-added weight key, still
  // yields a complete, valid set). Unknown extra keys are dropped.
  const weightsPreset = (v: unknown, fallback: IndicatorWeights): IndicatorWeights => {
    const src = (v && typeof v === 'object' ? v : {}) as Partial<Record<IndicatorKey, unknown>>;
    const out = {} as IndicatorWeights;
    (Object.keys(fallback) as IndicatorKey[]).forEach((k) => {
      out[k] = nonNeg(src[k], fallback[k]);
    });
    return out;
  };
  const accountId =
    input.liveAccountId === null
      ? null
      : typeof input.liveAccountId === 'string' && input.liveAccountId.trim() !== ''
        ? input.liveAccountId.trim()
        : d.liveAccountId;
  const enabledAt =
    typeof input.liveEnabledAt === 'number' && Number.isFinite(input.liveEnabledAt) ? input.liveEnabledAt : null;
  const optionsEnabledAt =
    typeof input.liveOptionsEnabledAt === 'number' && Number.isFinite(input.liveOptionsEnabledAt)
      ? input.liveOptionsEnabledAt
      : null;
  return {
    enabled: typeof input.enabled === 'boolean' ? input.enabled : d.enabled,
    killSwitch: typeof input.killSwitch === 'boolean' ? input.killSwitch : d.killSwitch,
    riskProfile:
      input.riskProfile === 'AGGRESSIVE' || input.riskProfile === 'MODERATE' ? input.riskProfile : d.riskProfile,
    accountEquityUsd: equity,
    maxConcurrentPositions: posIntMin1(input.maxConcurrentPositions, d.maxConcurrentPositions),
    riskPerTradePct: pct(input.riskPerTradePct, d.riskPerTradePct),
    maxDailyDrawdownPct: pct(input.maxDailyDrawdownPct, d.maxDailyDrawdownPct),
    stepDownAfterLosses: posInt(input.stepDownAfterLosses, d.stepDownAfterLosses),
    stepDownSizeCutPct: pct(input.stepDownSizeCutPct, d.stepDownSizeCutPct),
    maxAggregateOpenRiskPct: pct(input.maxAggregateOpenRiskPct, d.maxAggregateOpenRiskPct),
    maxCorrelatedExposurePct: pct(input.maxCorrelatedExposurePct, d.maxCorrelatedExposurePct),
    maxSectorExposurePct: pct(input.maxSectorExposurePct, d.maxSectorExposurePct),
    maxTradesPerDay: posInt(input.maxTradesPerDay, d.maxTradesPerDay),
    regimeAtrThresholdPct: pct(input.regimeAtrThresholdPct, d.regimeAtrThresholdPct),
    regimeSizeCutPct: pct(input.regimeSizeCutPct, d.regimeSizeCutPct),
    equityCurveDeriskEnabled:
      typeof input.equityCurveDeriskEnabled === 'boolean' ? input.equityCurveDeriskEnabled : d.equityCurveDeriskEnabled,
    equityCurveLookbackDays: posIntMin1(input.equityCurveLookbackDays, d.equityCurveLookbackDays),
    equityCurveDeriskCutPct: pct(input.equityCurveDeriskCutPct, d.equityCurveDeriskCutPct),
    maxAdvParticipationPct: pct(input.maxAdvParticipationPct, d.maxAdvParticipationPct),
    convictionGradeAMinScore: pct(input.convictionGradeAMinScore, d.convictionGradeAMinScore),
    convictionGradeBMinScore: pct(input.convictionGradeBMinScore, d.convictionGradeBMinScore),
    expectancyWeightingEnabled:
      typeof input.expectancyWeightingEnabled === 'boolean'
        ? input.expectancyWeightingEnabled
        : d.expectancyWeightingEnabled,
    methodWeightingEnabled:
      typeof input.methodWeightingEnabled === 'boolean' ? input.methodWeightingEnabled : d.methodWeightingEnabled,
    expectancyMinTrades: posIntMin1(input.expectancyMinTrades, d.expectancyMinTrades),
    expectancyMinMultiplier: posDecimal(input.expectancyMinMultiplier, d.expectancyMinMultiplier),
    expectancyMaxMultiplier: posDecimal(input.expectancyMaxMultiplier, d.expectancyMaxMultiplier),
    tradeDirection:
      input.tradeDirection === 'long' || input.tradeDirection === 'short' || input.tradeDirection === 'both'
        ? input.tradeDirection
        : d.tradeDirection,
    minRelVol: nonNeg(input.minRelVol, d.minRelVol),
    minPrice: nonNeg(input.minPrice, d.minPrice),
    minAvgVolume: nonNeg(input.minAvgVolume, d.minAvgVolume),
    moversDiscoveryEnabled:
      typeof input.moversDiscoveryEnabled === 'boolean' ? input.moversDiscoveryEnabled : d.moversDiscoveryEnabled,
    minSignalScore: pct(input.minSignalScore, d.minSignalScore),
    requireWeeklyTrendAlignment:
      typeof input.requireWeeklyTrendAlignment === 'boolean'
        ? input.requireWeeklyTrendAlignment
        : d.requireWeeklyTrendAlignment,
    relativeStrengthWeight: pct(input.relativeStrengthWeight, d.relativeStrengthWeight),
    benchmarkSymbol:
      typeof input.benchmarkSymbol === 'string' && input.benchmarkSymbol.trim() !== ''
        ? input.benchmarkSymbol.trim().toUpperCase()
        : d.benchmarkSymbol,
    relativeStrengthLookbackDays: posIntMin1(input.relativeStrengthLookbackDays, d.relativeStrengthLookbackDays),
    sentimentWeight: pct(input.sentimentWeight, d.sentimentWeight),
    maxTickerAtrPct: pct(input.maxTickerAtrPct, d.maxTickerAtrPct),
    maxMarketAtrPct: pct(input.maxMarketAtrPct, d.maxMarketAtrPct),
    stopAtrMultiple: posDecimal(input.stopAtrMultiple, d.stopAtrMultiple),
    maxStopDistancePct: nonNeg(input.maxStopDistancePct, d.maxStopDistancePct),
    liveScaleOutEnabled:
      typeof input.liveScaleOutEnabled === 'boolean' ? input.liveScaleOutEnabled : d.liveScaleOutEnabled,
    liveTrailingEnabled:
      typeof input.liveTrailingEnabled === 'boolean' ? input.liveTrailingEnabled : d.liveTrailingEnabled,
    dayProtectiveStopEnabled:
      typeof input.dayProtectiveStopEnabled === 'boolean' ? input.dayProtectiveStopEnabled : d.dayProtectiveStopEnabled,
    shortDatedOptionsEnabled:
      typeof input.shortDatedOptionsEnabled === 'boolean' ? input.shortDatedOptionsEnabled : d.shortDatedOptionsEnabled,
    optionsHardExitMinutesBeforeClose: nonNeg(
      input.optionsHardExitMinutesBeforeClose,
      d.optionsHardExitMinutesBeforeClose,
    ),
    optionsNoEntryMinutesBeforeClose: nonNeg(
      input.optionsNoEntryMinutesBeforeClose,
      d.optionsNoEntryMinutesBeforeClose,
    ),
    optionsUnderlyingStopPct: nonNeg(input.optionsUnderlyingStopPct, d.optionsUnderlyingStopPct),
    optionsGiveBackArmPct: nonNeg(input.optionsGiveBackArmPct, d.optionsGiveBackArmPct),
    optionsGiveBackPct: nonNeg(input.optionsGiveBackPct, d.optionsGiveBackPct),
    optionsStagnationMinutes: nonNeg(input.optionsStagnationMinutes, d.optionsStagnationMinutes),
    optionsStagnationMinMovePct: nonNeg(input.optionsStagnationMinMovePct, d.optionsStagnationMinMovePct),
    optionsDisasterStopPct: nonNeg(input.optionsDisasterStopPct, d.optionsDisasterStopPct),
    targetRMultiple: posDecimal(input.targetRMultiple, d.targetRMultiple),
    sessionBufferMinutes: posInt(input.sessionBufferMinutes, d.sessionBufferMinutes),
    earningsBlackoutDays: posInt(input.earningsBlackoutDays, d.earningsBlackoutDays),
    minRelVolPace: nonNeg(input.minRelVolPace, d.minRelVolPace),
    minChangePct: nonNeg(input.minChangePct, d.minChangePct),
    momentumIntradayOnly:
      typeof input.momentumIntradayOnly === 'boolean' ? input.momentumIntradayOnly : d.momentumIntradayOnly,
    macroEventBlackoutHours: nonNeg(input.macroEventBlackoutHours, d.macroEventBlackoutHours),
    maxHoldDays: posInt(input.maxHoldDays, d.maxHoldDays),
    breakevenTriggerRMultiple: nonNeg(input.breakevenTriggerRMultiple, d.breakevenTriggerRMultiple),
    trailStartRMultiple: nonNeg(input.trailStartRMultiple, d.trailStartRMultiple),
    trailStopRMultiple: nonNeg(input.trailStopRMultiple, d.trailStopRMultiple),
    partialExitRMultiple: nonNeg(input.partialExitRMultiple, d.partialExitRMultiple),
    partialExitPct: pct(input.partialExitPct, d.partialExitPct),
    addOnTriggerRMultiple: nonNeg(input.addOnTriggerRMultiple, d.addOnTriggerRMultiple),
    addOnSizePct: pct(input.addOnSizePct, d.addOnSizePct),
    maxAddOns: posInt(input.maxAddOns, d.maxAddOns),
    correlationLookbackDays: posIntMin1(input.correlationLookbackDays, d.correlationLookbackDays),
    correlationThreshold: unitInterval(input.correlationThreshold, d.correlationThreshold),
    correlationAwareSelectionEnabled:
      typeof input.correlationAwareSelectionEnabled === 'boolean'
        ? input.correlationAwareSelectionEnabled
        : d.correlationAwareSelectionEnabled,
    regimeAdaptiveWeightsEnabled:
      typeof input.regimeAdaptiveWeightsEnabled === 'boolean'
        ? input.regimeAdaptiveWeightsEnabled
        : d.regimeAdaptiveWeightsEnabled,
    regimeWeightPresets: {
      riskOn: weightsPreset(input.regimeWeightPresets?.riskOn, d.regimeWeightPresets.riskOn),
      neutral: weightsPreset(input.regimeWeightPresets?.neutral, d.regimeWeightPresets.neutral),
      riskOff: weightsPreset(input.regimeWeightPresets?.riskOff, d.regimeWeightPresets.riskOff),
    },
    liveTradingEnabled: typeof input.liveTradingEnabled === 'boolean' ? input.liveTradingEnabled : d.liveTradingEnabled,
    liveEnabledAt: enabledAt,
    liveAccountId: accountId,
    liveMaxOrderUsd: nonNeg(input.liveMaxOrderUsd, d.liveMaxOrderUsd),
    liveMaxDailyLossUsd: nonNeg(input.liveMaxDailyLossUsd, d.liveMaxDailyLossUsd),
    liveMaxOrdersPerDay: posInt(input.liveMaxOrdersPerDay, d.liveMaxOrdersPerDay),
    liveFatFingerPct: pct(input.liveFatFingerPct, d.liveFatFingerPct),
    liveAllowNakedShort:
      typeof input.liveAllowNakedShort === 'boolean' ? input.liveAllowNakedShort : d.liveAllowNakedShort,
    liveProbationTrades: posInt(input.liveProbationTrades, d.liveProbationTrades),
    liveProbationSizeMultiplier: (() => {
      const n = Number(input.liveProbationSizeMultiplier);
      return Number.isFinite(n) && n > 0 && n <= 1 ? n : d.liveProbationSizeMultiplier;
    })(),
    liveScaleInEnabled: typeof input.liveScaleInEnabled === 'boolean' ? input.liveScaleInEnabled : d.liveScaleInEnabled,
    liveMaxAddOns: posInt(input.liveMaxAddOns, d.liveMaxAddOns),
    liveOptionsEnabled: typeof input.liveOptionsEnabled === 'boolean' ? input.liveOptionsEnabled : d.liveOptionsEnabled,
    liveOptionsEnabledAt: optionsEnabledAt,
    liveOptionsMaxOrderUsd: nonNeg(input.liveOptionsMaxOrderUsd, d.liveOptionsMaxOrderUsd),
    liveOptionsMaxDailyLossUsd: nonNeg(input.liveOptionsMaxDailyLossUsd, d.liveOptionsMaxDailyLossUsd),
    liveOptionsMaxOrdersPerDay: posInt(input.liveOptionsMaxOrdersPerDay, d.liveOptionsMaxOrdersPerDay),
    // Same null-or-positive shape as accountEquityUsd (it is a snapshot of it).
    liveCapsAnchorEquityUsd:
      input.liveCapsAnchorEquityUsd === null
        ? null
        : typeof input.liveCapsAnchorEquityUsd === 'number' && input.liveCapsAnchorEquityUsd > 0
          ? input.liveCapsAnchorEquityUsd
          : d.liveCapsAnchorEquityUsd,
    targetDailyGainPct:
      input.targetDailyGainPct === null
        ? null
        : typeof input.targetDailyGainPct === 'number' &&
            input.targetDailyGainPct > 0 &&
            input.targetDailyGainPct <= 1000
          ? input.targetDailyGainPct
          : d.targetDailyGainPct,
    // Same null-or-bounded shape as targetDailyGainPct (they are levels on the
    // same day-gain axis). The floor additionally allows 0 — "halt if an armed
    // day falls all the way back to flat" is a legitimate floor. The arm>floor
    // ordering is enforced where the guard is EVALUATED (dailyTarget.ts), not
    // here: sanitize sees one field at a time and a partial update must not
    // silently rewrite the other one.
    giveBackArmPct:
      input.giveBackArmPct === null
        ? null
        : typeof input.giveBackArmPct === 'number' && input.giveBackArmPct > 0 && input.giveBackArmPct <= 1000
          ? input.giveBackArmPct
          : d.giveBackArmPct,
    giveBackFloorPct:
      input.giveBackFloorPct === null
        ? null
        : typeof input.giveBackFloorPct === 'number' && input.giveBackFloorPct >= 0 && input.giveBackFloorPct <= 1000
          ? input.giveBackFloorPct
          : d.giveBackFloorPct,
    // 0 (and 1 — see the field's doc comment) reads as off downstream.
    symbolCooldownLosses: posInt(input.symbolCooldownLosses, d.symbolCooldownLosses),
    symbolCooldownWindowDays: posIntMin1(input.symbolCooldownWindowDays, d.symbolCooldownWindowDays),
    symbolCooldownDays: posIntMin1(input.symbolCooldownDays, d.symbolCooldownDays),
    finishLineSizingEnabled:
      typeof input.finishLineSizingEnabled === 'boolean' ? input.finishLineSizingEnabled : d.finishLineSizingEnabled,
    finishLineMinSignalScore: pct(input.finishLineMinSignalScore, d.finishLineMinSignalScore),
    stagnationExitMinutes: posInt(input.stagnationExitMinutes, d.stagnationExitMinutes),
    stagnationExitMinR: nonNeg(input.stagnationExitMinR, d.stagnationExitMinR),
    // Capped at the session's own length: a window longer than the trading day
    // would mean "always flattening", which is a way of saying "never enter".
    endOfDayFlattenMinutes: Math.min(posInt(input.endOfDayFlattenMinutes, d.endOfDayFlattenMinutes), 390),
    levelExitsEnabled: typeof input.levelExitsEnabled === 'boolean' ? input.levelExitsEnabled : d.levelExitsEnabled,
    // 0..1 — a strength outside that range can only be a mistake, so it falls
    // back rather than silently disabling (0) or blocking everything (>1).
    levelMinStrength: (() => {
      const n = Number(input.levelMinStrength);
      return Number.isFinite(n) && n >= 0 && n <= 1 ? n : d.levelMinStrength;
    })(),
    levelBufferPct: nonNeg(input.levelBufferPct, d.levelBufferPct),
    levelMaxStopWidenPct: nonNeg(input.levelMaxStopWidenPct, d.levelMaxStopWidenPct),
    levelMinRewardR: nonNeg(input.levelMinRewardR, d.levelMinRewardR),
    liveOptionsFatFingerPct: pct(input.liveOptionsFatFingerPct, d.liveOptionsFatFingerPct),
    liveOptionsProbationTrades: posInt(input.liveOptionsProbationTrades, d.liveOptionsProbationTrades),
    liveOptionsProbationSizeMultiplier: (() => {
      const n = Number(input.liveOptionsProbationSizeMultiplier);
      return Number.isFinite(n) && n > 0 && n <= 1 ? n : d.liveOptionsProbationSizeMultiplier;
    })(),
    optionsStrategyType:
      input.optionsStrategyType === 'debit_spread' ||
      input.optionsStrategyType === 'single_leg' ||
      input.optionsStrategyType === 'auto'
        ? input.optionsStrategyType
        : d.optionsStrategyType,
    optionsDeltaMin: unitInterval(input.optionsDeltaMin, d.optionsDeltaMin),
    optionsDeltaMax: unitInterval(input.optionsDeltaMax, d.optionsDeltaMax),
    optionsMaxSpreadPct: pct(input.optionsMaxSpreadPct, d.optionsMaxSpreadPct),
    optionsMinOpenInterest: posInt(input.optionsMinOpenInterest, d.optionsMinOpenInterest),
    optionsMinVolume: posInt(input.optionsMinVolume, d.optionsMinVolume),
    optionsMinDte: posInt(input.optionsMinDte, d.optionsMinDte),
    optionsMaxDte: posIntMin1(input.optionsMaxDte, d.optionsMaxDte),
    optionsIvRankMax: pct(input.optionsIvRankMax, d.optionsIvRankMax),
    optionsIvRankMin: pct(input.optionsIvRankMin, d.optionsIvRankMin),
    optionsMaxIvRvRatio: nonNeg(input.optionsMaxIvRvRatio, d.optionsMaxIvRvRatio),
    optionsStopLossPct: pct(input.optionsStopLossPct, d.optionsStopLossPct),
    optionsTakeProfitPct: pct(input.optionsTakeProfitPct, d.optionsTakeProfitPct),
    optionsBreakevenTriggerPct: pct(input.optionsBreakevenTriggerPct, d.optionsBreakevenTriggerPct),
    optionsTrailStartPct: pct(input.optionsTrailStartPct, d.optionsTrailStartPct),
    optionsTrailStopPct: pct(input.optionsTrailStopPct, d.optionsTrailStopPct),
    optionsPartialExitTriggerPct: pct(input.optionsPartialExitTriggerPct, d.optionsPartialExitTriggerPct),
    optionsPartialExitPct: pct(input.optionsPartialExitPct, d.optionsPartialExitPct),
    autoPromoteMoversEnabled:
      typeof input.autoPromoteMoversEnabled === 'boolean' ? input.autoPromoteMoversEnabled : d.autoPromoteMoversEnabled,
    autoPromoteThreshold: posIntMin1(input.autoPromoteThreshold, d.autoPromoteThreshold),
    autoPromoteWindowDays: posIntMin1(input.autoPromoteWindowDays, d.autoPromoteWindowDays),
    autoPromoteMaxSymbols: posInt(input.autoPromoteMaxSymbols, d.autoPromoteMaxSymbols),
    autoTuneEnabled: typeof input.autoTuneEnabled === 'boolean' ? input.autoTuneEnabled : d.autoTuneEnabled,
    autoTuneMinTrades: posIntMin1(input.autoTuneMinTrades, d.autoTuneMinTrades),
    autoTuneMaxStepPct: pct(input.autoTuneMaxStepPct, d.autoTuneMaxStepPct),
    autoTuneSlippageExcludePct: pct(input.autoTuneSlippageExcludePct, d.autoTuneSlippageExcludePct),
    autoTuneExitsEnabled:
      typeof input.autoTuneExitsEnabled === 'boolean' ? input.autoTuneExitsEnabled : d.autoTuneExitsEnabled,
    autoTuneExitMaxStep: posDecimal(input.autoTuneExitMaxStep, d.autoTuneExitMaxStep),
    autoTuneExitTunedAt: Number.isFinite(Number(input.autoTuneExitTunedAt))
      ? Number(input.autoTuneExitTunedAt)
      : d.autoTuneExitTunedAt,
    autoTuneRequireOosConfirmation:
      typeof input.autoTuneRequireOosConfirmation === 'boolean'
        ? input.autoTuneRequireOosConfirmation
        : d.autoTuneRequireOosConfirmation,
  };
}

/** The current persisted auto-trading config, or defaults (off, MODERATE) if unset/corrupt. */
export function getAutotradeConfig(): AutotradeConfig {
  const row = db.prepare('SELECT config FROM autotrade_config WHERE id = 1').get() as ConfigRow | undefined;
  if (!row) return defaultAutotradeConfig();
  try {
    return sanitize(JSON.parse(row.config) as Partial<AutotradeConfig>);
  } catch {
    return defaultAutotradeConfig();
  }
}

/** Merge a partial patch over the current config and persist it (singleton upsert). */
export function setAutotradeConfig(patch: Partial<AutotradeConfig>): AutotradeConfig {
  const next = sanitize({ ...getAutotradeConfig(), ...patch });
  db.prepare(
    `INSERT INTO autotrade_config (id, config, updated_at) VALUES (1, ?, ?)
     ON CONFLICT(id) DO UPDATE SET config = excluded.config, updated_at = excluded.updated_at`,
  ).run(JSON.stringify(next), Date.now());
  return next;
}

/** Engage or release the auto-trading kill switch (sticky halt). Convenience
 *  over setAutotradeConfig — mirrors db/trading.ts's setKillSwitch. */
export function setAutotradeKillSwitch(on: boolean): AutotradeConfig {
  return setAutotradeConfig({ killSwitch: on });
}
