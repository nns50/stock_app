import { db } from './index';
import { safeJsonParse } from '../util/json';

// Small key/value settings store (JSON values) used to remember UI state across
// restarts — e.g. the last screener config and the last options symbol.

export function getSetting<T = unknown>(key: string): T | undefined {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined;
  return safeJsonParse<T | undefined>(row?.value, undefined);
}

export function getAllSettings(): Record<string, unknown> {
  const rows = db.prepare('SELECT key, value FROM settings').all() as { key: string; value: string }[];
  const out: Record<string, unknown> = {};
  for (const r of rows) out[r.key] = safeJsonParse<unknown>(r.value, undefined);
  return out;
}

export function setSetting(key: string, value: unknown): void {
  db.prepare(
    `INSERT INTO settings(key, value, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
  ).run(key, JSON.stringify(value), Date.now());
}

export function deleteSetting(key: string): boolean {
  return db.prepare('DELETE FROM settings WHERE key = ?').run(key).changes > 0;
}
