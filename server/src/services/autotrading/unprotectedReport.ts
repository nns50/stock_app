/**
 * The states a `live_position_unprotected` row is written in.
 *
 * One vocabulary for the two readers that have to agree on it: the protection
 * sweep (liveExecute.ts), which journals once per position per STATE per ET day
 * because each row is a page, and the edge-leak scan (edgeLeakScanData.ts),
 * which splits the action by the same states so a kill-switch row reads as the
 * operator trading by hand rather than as a naked position.
 *
 *  - `kill_switch`: a kill switch held the sweep, so it placed, cancelled and
 *    closed nothing. Expected while the operator trades the position by hand.
 *  - `exit_working`: the app's own close is working on the position, so nothing
 *    was stacked on top of it.
 *  - `unconfirmed`: the holdings read failed, so it is not known whether the
 *    shares are still held, and nothing was acted on.
 *  - `naked`: shares confirmed held with no resting stop, and the automatic
 *    repair did not save it.
 */
export const UNPROTECTED_REPORT_STATES = ['kill_switch', 'exit_working', 'unconfirmed', 'naked'] as const;
export type UnprotectedReportState = (typeof UNPROTECTED_REPORT_STATES)[number];

/**
 * The state of an unprotected report, from the row's detail.
 *
 * A row written since 2026-09-23 names it. An older one does not, and is read
 * from the fields every row since #637 carries: `heldByKillSwitch`,
 * `exitWorking`, and `heldAtBroker` (null when the holdings read failed).
 */
export function unprotectedReportState(detail: Record<string, unknown>): UnprotectedReportState {
  const named = detail.state;
  if (typeof named === 'string' && (UNPROTECTED_REPORT_STATES as readonly string[]).includes(named)) {
    return named as UnprotectedReportState;
  }
  if (detail.heldByKillSwitch === true) return 'kill_switch';
  if (detail.exitWorking === true) return 'exit_working';
  if (detail.heldAtBroker === null || detail.heldAtBroker === undefined) return 'unconfirmed';
  return 'naked';
}
