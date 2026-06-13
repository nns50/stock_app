import { describe, it, expect } from 'vitest';
import { DEFAULT_CHECKLIST_RULES, disciplineCount, rulesFromSetting } from './checklist';

describe('rulesFromSetting', () => {
  it('falls back to defaults for missing or non-array values', () => {
    expect(rulesFromSetting(undefined)).toEqual(DEFAULT_CHECKLIST_RULES);
    expect(rulesFromSetting('nope')).toEqual(DEFAULT_CHECKLIST_RULES);
    expect(rulesFromSetting([])).toEqual(DEFAULT_CHECKLIST_RULES);
  });
  it('keeps non-empty trimmed strings and drops junk', () => {
    expect(rulesFromSetting(['  Risk sized  ', '', 7, 'Exit defined'])).toEqual(['Risk sized', 'Exit defined']);
  });
});

describe('disciplineCount', () => {
  it('counts checked vs total, tolerating undefined', () => {
    expect(disciplineCount(undefined)).toEqual({ checked: 0, total: 0 });
    expect(
      disciplineCount([
        { rule: 'a', checked: true },
        { rule: 'b', checked: false },
        { rule: 'c', checked: true },
      ]),
    ).toEqual({ checked: 2, total: 3 });
  });
});
