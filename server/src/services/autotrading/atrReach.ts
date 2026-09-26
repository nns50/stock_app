// ---------------------------------------------------------------------------
// The ATR reachability gate's rule (live-only since 2026-09-01; liveExecute.ts).
//
// A stop further from the entry than `maxRiskAtrFraction` of the name's daily
// ATR needs more than a typical session's range to reach 1R, and the live book
// refuses the entry. With the stop derived as min(stopAtrMultiple x ATR,
// maxStopDistancePct of price), the settings of 2026-09 (1.5, 2.5%, 0.7) admit
// only names whose ATR is at least 2.5 / 0.7 = 3.57% of price: a universe
// filter as much as a setup filter (declinedEntryShadow.ts's header).
//
// One function for the live entry path and for every replay that asks what
// that path would have taken (the tape backfill's short readings), so the two
// cannot drift apart.
// ---------------------------------------------------------------------------

/** True when the live entry path's ATR reachability gate refuses this entry.
 *  Off at a fraction of 0; a name with no ATR is not refused, because the gate
 *  cannot judge a range it has no reading of. */
export function atrReachRefuses(
  entry: number,
  stop: number,
  atr: number | null | undefined,
  maxRiskAtrFraction: number,
): boolean {
  if (!(maxRiskAtrFraction > 0) || atr === null || atr === undefined || !(atr > 0)) return false;
  return Math.abs(entry - stop) > atr * maxRiskAtrFraction;
}
