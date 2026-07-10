// ---------------------------------------------------------------------------
// docs/AUTOTRADING_SPEC.md — RISK PROFILES. Originally a MODERATE/AGGRESSIVE
// preset table; every field it held (riskPerTradePct, maxDailyDrawdownPct,
// stepDownAfterLosses, stepDownSizeCutPct, maxAggregateOpenRiskPct,
// maxCorrelatedExposurePct, maxTradesPerDay) has since moved out to become a
// directly user-configurable field on AutotradeConfig instead — see each
// field's own doc comment there. maxConcurrentPositions led this (2026-07-10,
// task #90); everything else followed the same day, reported directly:
// raising maxConcurrentPositions alone (to 15) didn't unblock new entries
// with only 2 positions open, because maxAggregateOpenRiskPct — 2% of equity
// at the old MODERATE preset, about 2 positions' worth of risk at 1%/trade —
// was the one actually binding, and every other profile number had the exact
// same "no independent lever" problem once you looked for it.
//
// Switching riskProfile no longer touches ANY of these numbers, by design —
// silently resetting a value the user explicitly set, just because they
// flipped an unrelated toggle, would be a worse surprise than leaving
// profile-switching alone (this reasoning predates this file's emptying out;
// see AutotradeConfig.maxConcurrentPositions's own comment). `riskProfile`
// itself is kept on AutotradeConfig purely as a label today (still gates the
// AGGRESSIVE-switch confirmation dialog) — it has no remaining computational
// effect on risk-check math.
// ---------------------------------------------------------------------------

/**
 * Statistical-correlation exposure check's methodology constants (the
 * window/threshold the spec's resolved decisions explicitly deferred to this
 * phase) — NOT part of the old per-profile preset table (both profiles always
 * shared these), and not a risk-tolerance dial the way maxCorrelatedExposurePct
 * is: this is how correlation is MEASURED, not a pass/fail cap. 30 trading
 * days (~6 weeks) is long enough to be statistically meaningful, short enough
 * to reflect the current correlation regime; |r| ≥ 0.7 is the standard
 * "strong correlation" convention. Tunable defaults, not laws of physics —
 * revisit if backtesting suggests otherwise.
 */
export const CORRELATION_LOOKBACK_DAYS = 30;
export const CORRELATION_THRESHOLD = 0.7;
