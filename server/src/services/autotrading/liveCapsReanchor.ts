import { AutotradeConfig, getAutotradeConfig, setAutotradeConfig } from '../../db/autotradeConfig';
import { logAutotradeEvent } from '../../db/autotradeEvents';
import { DOLLAR_CAP_KEYS, deriveDollarCaps, DollarCapKey } from './targetTune';

// ---------------------------------------------------------------------------
// Automatic re-anchoring of the equity-derived DOLLAR caps.
//
// A "tune from target" apply derives four dollar caps from the account equity
// of that moment (targetTune.ts's shapeToPatch): liveMaxOrderUsd /
// liveMaxDailyLossUsd and their options twins. The PERCENT caps stay honest on
// their own — accountEquityUsd is re-synced from the broker every loop tick,
// and a percent is applied to it at decision time — but a stored dollar figure
// is frozen at whatever equity it was computed from. As the account grows it
// quietly tightens (halting earlier than the tuned drawdown %), and as the
// account shrinks it quietly LOOSENS — a $903 daily-loss cap on a book that
// has fallen from $6.9k to $4k is a 22% halt wearing a 13% label, permission
// to lose the most exactly when losses are compounding.
//
// So: when synced equity has drifted ≥ REANCHOR_THRESHOLD_PCT from the equity
// the caps were last derived from (cfg.liveCapsAnchorEquityUsd — stamped by
// every tune apply and by each re-anchor), re-derive them at current equity
// using the SAME formulas the tune used, and move the anchor. Updating the
// anchor is what makes this converge: the next re-anchor needs a fresh ≥15%
// move from the NEW equity, so mark-to-market noise can never make it churn.
//
// Hand-edits stay the user's. A cap is only rewritten while it still equals
// its anchor-derived value; one that differs was deliberately set by a human
// and is skipped (and named in the event). This is the same "only move what
// you own" rule that keeps the tune itself from stomping deliberate config.
//
// Never armed unless a tune (or an explicit config write) set the anchor —
// liveCapsAnchorEquityUsd defaults to null, and this whole file is a no-op
// until it isn't.
// ---------------------------------------------------------------------------

/** Re-derive once equity has moved this far (either direction) from the
 *  anchor. 15% is far above mark-to-market noise between ticks, and small
 *  enough that the caps never drift meaningfully out of proportion. */
export const REANCHOR_THRESHOLD_PCT = 15;

// The cap list, their arithmetic, and the hand-edit test all live in
// targetTune.ts now, beside the formulas that produce them — this file and the
// tuner MUST agree on all three or a freshly-applied tune would immediately
// look drifted. Re-exported so this module's own surface is unchanged.
export { DOLLAR_CAP_KEYS, deriveDollarCaps, handEditedDollarCaps } from './targetTune';
export type { DollarCapKey, DollarCaps } from './targetTune';

export type ReanchorDecision =
  | { action: 'skip'; reason: string }
  | {
      action: 'reanchor';
      patch: Partial<AutotradeConfig>;
      /** Caps rewritten, with the movement — for the journal event. */
      changes: Partial<Record<DollarCapKey, { from: number; to: number }>>;
      /** Caps left alone because they no longer match their anchor-derived
       *  value — someone set them by hand, so they are not ours to move. */
      handEdited: DollarCapKey[];
      driftPct: number;
    };

/** Pure decision — all I/O stays in reanchorLiveCapsIfDrifted. */
export function decideLiveCapsReanchor(cfg: AutotradeConfig, equityUsd: number | null | undefined): ReanchorDecision {
  const anchor = cfg.liveCapsAnchorEquityUsd;
  if (anchor === null || !(anchor > 0)) {
    return { action: 'skip', reason: 'not armed — no anchor equity recorded (apply a tune to arm)' };
  }
  if (equityUsd === null || equityUsd === undefined || !(equityUsd > 0)) {
    return { action: 'skip', reason: 'no usable account equity to re-anchor against' };
  }
  const driftPct = (Math.abs(equityUsd - anchor) / anchor) * 100;
  if (driftPct < REANCHOR_THRESHOLD_PCT) {
    return {
      action: 'skip',
      reason: `equity within ${REANCHOR_THRESHOLD_PCT}% of the anchor (${driftPct.toFixed(1)}% drift)`,
    };
  }

  const atAnchor = deriveDollarCaps(cfg, anchor);
  const atCurrent = deriveDollarCaps(cfg, equityUsd);
  // Anchor moves regardless of how many caps were ours to move — otherwise a
  // fully hand-edited config would re-trip this branch every tick forever.
  const patch: Partial<AutotradeConfig> = { liveCapsAnchorEquityUsd: equityUsd };
  const changes: Partial<Record<DollarCapKey, { from: number; to: number }>> = {};
  const handEdited: DollarCapKey[] = [];
  for (const key of DOLLAR_CAP_KEYS) {
    if (cfg[key] === atAnchor[key]) {
      patch[key] = atCurrent[key];
      changes[key] = { from: cfg[key], to: atCurrent[key] };
    } else {
      handEdited.push(key);
    }
  }
  return { action: 'reanchor', patch, changes, handEdited, driftPct: Math.round(driftPct * 10) / 10 };
}

/**
 * Loop-tick entry point: re-derive the dollar caps from the just-synced
 * equity when it has drifted past the threshold. Journals one `config` event
 * per re-anchor (a rare, deliberate-feeling change worth a record — unlike
 * the per-tick equity sync, which is deliberately silent).
 */
export function reanchorLiveCapsIfDrifted(): ReanchorDecision {
  const cfg = getAutotradeConfig();
  const decision = decideLiveCapsReanchor(cfg, cfg.accountEquityUsd);
  if (decision.action === 'reanchor') {
    setAutotradeConfig(decision.patch);
    logAutotradeEvent({
      stage: 'config',
      action: 'live_caps_reanchored',
      detail: {
        anchorEquityUsd: cfg.liveCapsAnchorEquityUsd,
        currentEquityUsd: cfg.accountEquityUsd,
        driftPct: decision.driftPct,
        changes: decision.changes,
        skippedHandEdited: decision.handEdited,
      },
      riskProfile: cfg.riskProfile,
    });
  }
  return decision;
}
