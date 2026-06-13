import type { ChecklistItem } from '../api/types';

/** Settings key under which the user's editable rule list is persisted. */
export const CHECKLIST_SETTING_KEY = 'pretradeChecklist';

/** Sensible starter rules — used until the user customizes their own. */
export const DEFAULT_CHECKLIST_RULES: string[] = [
  'Trade fits my plan / setup',
  'Risk is within my budget (position sized)',
  'Exit plan defined — target and stop',
  'Not chasing or revenge-trading',
  'Checked the chart and key levels',
];

/** Coerce a persisted setting value into a clean list of rule strings. */
export function rulesFromSetting(value: unknown): string[] {
  if (!Array.isArray(value)) return DEFAULT_CHECKLIST_RULES;
  const rules = value.filter((v): v is string => typeof v === 'string' && v.trim().length > 0).map((v) => v.trim());
  return rules.length ? rules : DEFAULT_CHECKLIST_RULES;
}

/** How many rules were acknowledged, out of the total recorded. */
export function disciplineCount(checklist: ChecklistItem[] | undefined): { checked: number; total: number } {
  const total = checklist?.length ?? 0;
  const checked = checklist?.filter((c) => c.checked).length ?? 0;
  return { checked, total };
}
