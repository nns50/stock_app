import { describe, it, expect } from 'vitest';
import {
  canTransition,
  assertTransition,
  isTerminal,
  nextStates,
  TERMINAL_STATES,
  INITIAL_STATE,
  IllegalTransitionError,
  type OrderState,
  positionsWithWorkingClose,
} from '../src/services/trading/orderLifecycle';

describe('order lifecycle', () => {
  it('starts at draft', () => {
    expect(INITIAL_STATE).toBe('draft');
  });

  it('allows the happy path through to filled', () => {
    const path: OrderState[] = ['draft', 'validated', 'confirmed', 'submitted', 'acknowledged', 'filled'];
    for (let i = 0; i < path.length - 1; i++) {
      expect(canTransition(path[i], path[i + 1])).toBe(true);
    }
  });

  it('rejects illegal jumps', () => {
    expect(canTransition('draft', 'submitted')).toBe(false);
    expect(canTransition('draft', 'filled')).toBe(false);
    expect(canTransition('validated', 'acknowledged')).toBe(false);
  });

  it('treats fills/cancels/rejects/expiries as terminal', () => {
    for (const s of ['filled', 'cancelled', 'rejected', 'expired'] as OrderState[]) {
      expect(isTerminal(s)).toBe(true);
      expect(nextStates(s)).toEqual([]);
    }
    expect(TERMINAL_STATES.size).toBe(4);
  });

  it('cannot leave a terminal state', () => {
    expect(canTransition('filled', 'cancelled')).toBe(false);
    expect(() => assertTransition('rejected', 'submitted')).toThrow(IllegalTransitionError);
  });

  it('allows a partial fill to repeat then complete', () => {
    expect(canTransition('acknowledged', 'partially_filled')).toBe(true);
    expect(canTransition('partially_filled', 'partially_filled')).toBe(true);
    expect(canTransition('partially_filled', 'filled')).toBe(true);
  });

  it('allows rejection from every pre-ack state and cancel where sensible', () => {
    for (const s of ['draft', 'validated', 'confirmed', 'submitted'] as OrderState[]) {
      expect(canTransition(s, 'rejected')).toBe(true);
    }
    expect(canTransition('confirmed', 'cancelled')).toBe(true);
    expect(canTransition('acknowledged', 'cancelled')).toBe(true);
  });

  it('carries from/to on the IllegalTransitionError', () => {
    const err = (() => {
      try {
        assertTransition('draft', 'filled');
      } catch (e) {
        return e;
      }
    })();
    expect(err).toBeInstanceOf(IllegalTransitionError);
    expect((err as IllegalTransitionError).from).toBe('draft');
    expect((err as IllegalTransitionError).to).toBe('filled');
  });
});

// One definition of "a close is working" for the positions sync and the
// bracket-leg read (#147, on review 2026-09-25): a role='exit' row whose intent
// is not terminal. A filled scale-out's row stays in the reconcile's pending
// list while its position is open; it is not a working close.
describe('positionsWithWorkingClose', () => {
  const states: Record<number, OrderState | undefined> = {
    1: 'acknowledged',
    2: 'filled',
    3: 'partially_filled',
    4: 'cancelled',
  };
  const stateOf = (id: number) => states[id];

  it('counts an exit whose intent is still live, and not one that is done', () => {
    const rows = [
      { role: 'exit', positionId: 10, intentId: 1 },
      { role: 'exit', positionId: 20, intentId: 2 },
      { role: 'exit', positionId: 30, intentId: 3 },
      { role: 'exit', positionId: 40, intentId: 4 },
    ];
    expect([...positionsWithWorkingClose(rows, stateOf)].sort()).toEqual([10, 30]);
  });

  it('ignores entry rows and rows without a position, and counts an unknown intent as working', () => {
    const rows = [
      { role: 'entry', positionId: 50, intentId: 1 },
      { role: 'exit', positionId: null, intentId: 1 },
      { role: 'exit', positionId: 60, intentId: 99 },
    ];
    expect([...positionsWithWorkingClose(rows, stateOf)]).toEqual([60]);
  });
});
