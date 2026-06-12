import { db } from './index';
import { AlertKind, AlertOperator } from '../services/alertEngine';

export interface Alert {
  id: number;
  symbol: string;
  kind: AlertKind;
  operator: AlertOperator;
  threshold: number;
  note: string | null;
  enabled: boolean;
  triggered: boolean;
  lastValue: number | null;
  triggerMessage: string | null;
  lastTriggeredAt: number | null;
  createdAt: number;
  updatedAt: number;
}

interface AlertRow {
  id: number;
  symbol: string;
  kind: AlertKind;
  operator: AlertOperator;
  threshold: number;
  note: string | null;
  enabled: number;
  triggered: number;
  last_value: number | null;
  trigger_message: string | null;
  last_triggered_at: number | null;
  created_at: number;
  updated_at: number;
}

function map(r: AlertRow): Alert {
  return {
    id: r.id,
    symbol: r.symbol,
    kind: r.kind,
    operator: r.operator,
    threshold: r.threshold,
    note: r.note,
    enabled: !!r.enabled,
    triggered: !!r.triggered,
    lastValue: r.last_value,
    triggerMessage: r.trigger_message,
    lastTriggeredAt: r.last_triggered_at,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

export interface AlertInput {
  symbol: string;
  kind: AlertKind;
  operator: AlertOperator;
  threshold: number;
  note?: string | null;
}

export function listAlerts(enabledOnly = false): Alert[] {
  const sql = `SELECT * FROM alerts ${enabledOnly ? 'WHERE enabled = 1' : ''} ORDER BY triggered DESC, symbol`;
  return (db.prepare(sql).all() as AlertRow[]).map(map);
}

export function getAlert(id: number): Alert | undefined {
  const row = db.prepare('SELECT * FROM alerts WHERE id = ?').get(id) as AlertRow | undefined;
  return row ? map(row) : undefined;
}

export function createAlert(input: AlertInput): Alert {
  const now = Date.now();
  const res = db
    .prepare(
      `INSERT INTO alerts(symbol, kind, operator, threshold, note, enabled, triggered, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 1, 0, ?, ?)`,
    )
    .run(input.symbol.toUpperCase(), input.kind, input.operator, input.threshold, input.note ?? null, now, now);
  return getAlert(Number(res.lastInsertRowid))!;
}

export interface AlertPatch {
  threshold?: number;
  note?: string | null;
  enabled?: boolean;
  /** Acknowledge/re-arm: clears the triggered flag. */
  triggered?: boolean;
}

export function updateAlert(id: number, patch: AlertPatch): Alert | undefined {
  if (!getAlert(id)) return undefined;
  const fields: string[] = [];
  const params: unknown[] = [];
  const set = (col: string, val: unknown) => {
    fields.push(`${col} = ?`);
    params.push(val);
  };
  if (patch.threshold !== undefined) set('threshold', patch.threshold);
  if (patch.note !== undefined) set('note', patch.note);
  if (patch.enabled !== undefined) set('enabled', patch.enabled ? 1 : 0);
  if (patch.triggered !== undefined) {
    set('triggered', patch.triggered ? 1 : 0);
    if (!patch.triggered) set('trigger_message', null);
  }
  if (fields.length === 0) return getAlert(id);
  set('updated_at', Date.now());
  params.push(id);
  db.prepare(`UPDATE alerts SET ${fields.join(', ')} WHERE id = ?`).run(...params);
  return getAlert(id);
}

export function deleteAlert(id: number): boolean {
  return db.prepare('DELETE FROM alerts WHERE id = ?').run(id).changes > 0;
}

/** Persist an evaluation result; flips to triggered (one-shot) when newly met. */
export function applyEvaluation(id: number, value: number | null, triggered: boolean, message: string | null): void {
  const now = Date.now();
  const existing = getAlert(id);
  if (!existing) return;
  if (triggered && !existing.triggered) {
    db.prepare(
      'UPDATE alerts SET last_value = ?, triggered = 1, trigger_message = ?, last_triggered_at = ?, updated_at = ? WHERE id = ?',
    ).run(value, message, now, now, id);
  } else {
    db.prepare('UPDATE alerts SET last_value = ?, updated_at = ? WHERE id = ?').run(value, now, id);
  }
}
