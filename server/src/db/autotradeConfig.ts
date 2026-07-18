import { db } from './index';

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
 *  not something the loop silently switches to based on market conditions. */
export type OptionsStrategyType = 'single_leg' | 'debit_spread';

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
  // AUTOTRADING_SPEC.md — RESOLVED DECISIONS, added 2026-07-11). PAPER and
  // BACKTEST equity positions only for now — LIVE equity positions are
  // untouched (see the spec's own writeup on why: modifying/partially
  // closing a resting live bracket has no existing precedent and a
  // meaningfully worse failure mode than maxHoldDays' own live force-close
  // did). All five default to 0/disabled, so an untouched config's behavior
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
    tradeDirection: 'long',
    minRelVol: 1.5,
    requireWeeklyTrendAlignment: false,
    relativeStrengthWeight: 0,
    benchmarkSymbol: 'SPY',
    relativeStrengthLookbackDays: 20,
    sentimentWeight: 0,
    maxTickerAtrPct: 15,
    maxMarketAtrPct: 5,
    stopAtrMultiple: 1.5,
    targetRMultiple: 2,
    sessionBufferMinutes: 15,
    earningsBlackoutDays: 0,
    maxHoldDays: 0,
    breakevenTriggerRMultiple: 0,
    trailStartRMultiple: 0,
    trailStopRMultiple: 0,
    partialExitRMultiple: 0,
    partialExitPct: 50,
    correlationLookbackDays: 30,
    correlationThreshold: 0.7,
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
    liveOptionsEnabled: false,
    liveOptionsEnabledAt: null,
    liveOptionsMaxOrderUsd: 500,
    liveOptionsMaxDailyLossUsd: 250,
    liveOptionsMaxOrdersPerDay: DEFAULT_LIVE_MAX_ORDERS_PER_DAY,
    liveOptionsFatFingerPct: 10,
    liveOptionsProbationTrades: 20,
    liveOptionsProbationSizeMultiplier: 0.5,
    optionsStrategyType: 'single_leg',
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
    tradeDirection:
      input.tradeDirection === 'long' || input.tradeDirection === 'short' || input.tradeDirection === 'both'
        ? input.tradeDirection
        : d.tradeDirection,
    minRelVol: nonNeg(input.minRelVol, d.minRelVol),
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
    targetRMultiple: posDecimal(input.targetRMultiple, d.targetRMultiple),
    sessionBufferMinutes: posInt(input.sessionBufferMinutes, d.sessionBufferMinutes),
    earningsBlackoutDays: posInt(input.earningsBlackoutDays, d.earningsBlackoutDays),
    maxHoldDays: posInt(input.maxHoldDays, d.maxHoldDays),
    breakevenTriggerRMultiple: nonNeg(input.breakevenTriggerRMultiple, d.breakevenTriggerRMultiple),
    trailStartRMultiple: nonNeg(input.trailStartRMultiple, d.trailStartRMultiple),
    trailStopRMultiple: nonNeg(input.trailStopRMultiple, d.trailStopRMultiple),
    partialExitRMultiple: nonNeg(input.partialExitRMultiple, d.partialExitRMultiple),
    partialExitPct: pct(input.partialExitPct, d.partialExitPct),
    correlationLookbackDays: posIntMin1(input.correlationLookbackDays, d.correlationLookbackDays),
    correlationThreshold: unitInterval(input.correlationThreshold, d.correlationThreshold),
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
    liveOptionsEnabled: typeof input.liveOptionsEnabled === 'boolean' ? input.liveOptionsEnabled : d.liveOptionsEnabled,
    liveOptionsEnabledAt: optionsEnabledAt,
    liveOptionsMaxOrderUsd: nonNeg(input.liveOptionsMaxOrderUsd, d.liveOptionsMaxOrderUsd),
    liveOptionsMaxDailyLossUsd: nonNeg(input.liveOptionsMaxDailyLossUsd, d.liveOptionsMaxDailyLossUsd),
    liveOptionsMaxOrdersPerDay: posInt(input.liveOptionsMaxOrdersPerDay, d.liveOptionsMaxOrdersPerDay),
    liveOptionsFatFingerPct: pct(input.liveOptionsFatFingerPct, d.liveOptionsFatFingerPct),
    liveOptionsProbationTrades: posInt(input.liveOptionsProbationTrades, d.liveOptionsProbationTrades),
    liveOptionsProbationSizeMultiplier: (() => {
      const n = Number(input.liveOptionsProbationSizeMultiplier);
      return Number.isFinite(n) && n > 0 && n <= 1 ? n : d.liveOptionsProbationSizeMultiplier;
    })(),
    optionsStrategyType:
      input.optionsStrategyType === 'debit_spread' || input.optionsStrategyType === 'single_leg'
        ? input.optionsStrategyType
        : d.optionsStrategyType,
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
