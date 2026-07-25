import { db } from './index';
import { safeJsonParse } from '../util/json';

export type PresetKind = 'screener' | 'option_entry' | 'option_exit';

export interface Preset {
  id: number;
  name: string;
  kind: PresetKind;
  config: unknown;
  createdAt: number;
  updatedAt: number;
}

interface PresetRow {
  id: number;
  name: string;
  kind: PresetKind;
  config: string;
  created_at: number;
  updated_at: number;
}

function map(row: PresetRow): Preset {
  return {
    id: row.id,
    name: row.name,
    kind: row.kind,
    config: safeJsonParse<unknown>(row.config, null),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function listPresets(kind?: PresetKind): Preset[] {
  const rows = kind
    ? (db.prepare('SELECT * FROM presets WHERE kind = ? ORDER BY name').all(kind) as PresetRow[])
    : (db.prepare('SELECT * FROM presets ORDER BY kind, name').all() as PresetRow[]);
  return rows.map(map);
}

export function getPreset(id: number): Preset | undefined {
  const row = db.prepare('SELECT * FROM presets WHERE id = ?').get(id) as PresetRow | undefined;
  return row ? map(row) : undefined;
}

/** Upsert a preset by (name, kind). */
export function savePreset(name: string, kind: PresetKind, configObj: unknown): Preset {
  const now = Date.now();
  const config = JSON.stringify(configObj);
  db.prepare(
    `INSERT INTO presets(name, kind, config, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(name, kind) DO UPDATE SET config = excluded.config, updated_at = excluded.updated_at`,
  ).run(name, kind, config, now, now);
  const row = db.prepare('SELECT * FROM presets WHERE name = ? AND kind = ?').get(name, kind) as PresetRow;
  return map(row);
}

export function deletePreset(id: number): boolean {
  return db.prepare('DELETE FROM presets WHERE id = ?').run(id).changes > 0;
}
