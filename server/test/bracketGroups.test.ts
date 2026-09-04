import { describe, expect, it } from 'vitest';
import { WebullOpenOrder } from '../src/providers/webull/orders';
import {
  attributeByEntryOrder,
  groupExitLegsByCombo,
  isSingleBracket,
  summarizeGroups,
} from '../src/services/autotrading/bracketGroups';

const leg = (clientOrderId: string, comboOrderId?: string): WebullOpenOrder => ({
  clientOrderId,
  comboOrderId,
  symbol: 'IOT',
  side: 'sell',
  status: 'OPEN',
});

describe('groupExitLegsByCombo', () => {
  it('puts the two legs of one bracket in one group', () => {
    const g = groupExitLegsByCombo([leg('tp', 'A'), leg('sl', 'A')]);
    expect(g.groups).toHaveLength(1);
    expect(g.groups[0].legs.map((l) => l.clientOrderId)).toEqual(['tp', 'sl']);
    expect(g.unattributable).toEqual([]);
  });

  // The two-lot entry shape, and the 2026-07-09 double-open shape.
  it('separates two brackets on the same symbol', () => {
    const g = groupExitLegsByCombo([leg('tpA', 'A'), leg('slA', 'A'), leg('tpB', 'B'), leg('slB', 'B')]);
    expect(g.groups).toHaveLength(2);
    expect(g.groups.map((x) => x.comboOrderId)).toEqual(['A', 'B']);
    expect(g.groups.every((x) => x.legs.length === 2)).toBe(true);
  });

  // Mis-attributing a stop leg is how a bracket gets resized against the wrong
  // lot, so an unreadable id must never join the nearest group.
  it('never folds an unreadable leg into a group', () => {
    const g = groupExitLegsByCombo([leg('tp', 'A'), leg('mystery', undefined), leg('sl', 'A')]);
    expect(g.groups).toHaveLength(1);
    expect(g.groups[0].legs).toHaveLength(2);
    expect(g.unattributable.map((l) => l.clientOrderId)).toEqual(['mystery']);
  });

  it('handles an empty list', () => {
    expect(groupExitLegsByCombo([])).toEqual({ groups: [], unattributable: [] });
  });

  it('keeps first-seen group order', () => {
    const g = groupExitLegsByCombo([leg('b1', 'B'), leg('a1', 'A'), leg('b2', 'B')]);
    expect(g.groups.map((x) => x.comboOrderId)).toEqual(['B', 'A']);
  });
});

describe('attributeByEntryOrder', () => {
  const grouped = groupExitLegsByCombo([leg('tpA', 'A'), leg('slA', 'A'), leg('tpB', 'B'), leg('slB', 'B')]);

  it('finds the group whose id equals the entry order id', () => {
    expect(attributeByEntryOrder(grouped, 'B')?.comboOrderId).toBe('B');
  });

  // Every null path below must read as "cannot attribute", never as "no bracket".
  it('returns null with no id to match on', () => {
    expect(attributeByEntryOrder(grouped, null)).toBeNull();
    expect(attributeByEntryOrder(grouped, undefined)).toBeNull();
    expect(attributeByEntryOrder(grouped, '')).toBeNull();
  });

  it('returns null when no group carries the id', () => {
    expect(attributeByEntryOrder(grouped, 'ZZZ')).toBeNull();
  });

  it('never guesses when only unattributable legs exist', () => {
    const g = groupExitLegsByCombo([leg('x'), leg('y')]);
    expect(attributeByEntryOrder(g, 'A')).toBeNull();
    expect(g.unattributable).toHaveLength(2);
  });
});

describe('isSingleBracket', () => {
  it('is true for exactly one clean group', () => {
    expect(isSingleBracket(groupExitLegsByCombo([leg('tp', 'A'), leg('sl', 'A')]))).toBe(true);
  });

  it('is false for two groups', () => {
    expect(isSingleBracket(groupExitLegsByCombo([leg('a', 'A'), leg('b', 'B')]))).toBe(false);
  });

  // A parse miss must not read as the simple case the old assumptions need.
  it('is false when any leg is unreadable, even with one group', () => {
    expect(isSingleBracket(groupExitLegsByCombo([leg('tp', 'A'), leg('sl', 'A'), leg('?')]))).toBe(false);
  });

  it('is false for an empty book', () => {
    expect(isSingleBracket(groupExitLegsByCombo([]))).toBe(false);
  });
});

describe('summarizeGroups', () => {
  it('reports ids and counts without dumping legs', () => {
    const s = summarizeGroups(groupExitLegsByCombo([leg('a', 'A'), leg('b', 'A'), leg('c', 'B'), leg('d')]));
    expect(s).toEqual({
      groupCount: 2,
      unattributableCount: 1,
      groups: [
        { comboOrderId: 'A', legs: 2 },
        { comboOrderId: 'B', legs: 1 },
      ],
    });
  });
});
