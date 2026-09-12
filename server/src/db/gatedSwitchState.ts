import { db } from './index';
import type { SwitchState } from '../services/autotrading/gatedSwitches';

// ---------------------------------------------------------------------------
// The gated-switch engine's shadow record — see the DDL comment in db/index.ts
// for why it is durable rather than in-memory.
// ---------------------------------------------------------------------------

interface Row {
  rule_id: string;
  evaluations: number;
  proposals: number;
  contradictions: number;
  last_met: number;
  last_evaluated_et_date: string | null;
  graduated_at: number | null;
}

const map = (r: Row): SwitchState => ({
  ruleId: r.rule_id,
  evaluations: r.evaluations,
  proposals: r.proposals,
  contradictions: r.contradictions,
  lastMet: r.last_met === 1,
  lastEvaluatedEtDate: r.last_evaluated_et_date,
  graduatedAt: r.graduated_at,
});

export function listSwitchStates(): Map<string, SwitchState> {
  const rows = db.prepare('SELECT * FROM gated_switch_state').all() as Row[];
  return new Map(rows.map((r) => [r.rule_id, map(r)]));
}

export function saveSwitchState(s: SwitchState): void {
  db.prepare(
    `INSERT INTO gated_switch_state
       (rule_id, evaluations, proposals, contradictions, last_met, last_evaluated_et_date, graduated_at)
     VALUES (?,?,?,?,?,?,?)
     ON CONFLICT(rule_id) DO UPDATE SET
       evaluations = excluded.evaluations,
       proposals = excluded.proposals,
       contradictions = excluded.contradictions,
       last_met = excluded.last_met,
       last_evaluated_et_date = excluded.last_evaluated_et_date,
       -- A graduation is one-way: once a rule has earned it, a later write
       -- that happens to carry null must not silently un-graduate it.
       graduated_at = COALESCE(excluded.graduated_at, gated_switch_state.graduated_at)`,
  ).run(
    s.ruleId,
    s.evaluations,
    s.proposals,
    s.contradictions,
    s.lastMet ? 1 : 0,
    s.lastEvaluatedEtDate,
    s.graduatedAt,
  );
}
