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
