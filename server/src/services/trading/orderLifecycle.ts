// ---------------------------------------------------------------------------
// Order-state lifecycle for live trading (docs/LIVE_TRADING_DESIGN.md §6).
//
// PURE: no I/O. Just the legal states and the transitions every order must
// follow, so the persistence layer can reject illegal jumps and the audit
// trail stays sound. Nothing here places an order.
//
//   draft → validated → confirmed → submitted → acknowledged
//     │         │           │           │            ├→ partially_filled ⇄ (self)
//     └─────────┴───────────┴───────────┘            ├→ filled        (terminal)
//                (any can be rejected)               ├→ cancelled     (terminal)
//   confirmed can also be cancelled before submit    └→ expired       (terminal)
// ---------------------------------------------------------------------------

export type OrderState =
  | 'draft'
  | 'validated'
  | 'confirmed'
  | 'submitted'
  | 'acknowledged'
  | 'partially_filled'
  | 'filled'
  | 'cancelled'
  | 'rejected'
  | 'expired';

export const INITIAL_STATE: OrderState = 'draft';

const TRANSITIONS: Record<OrderState, OrderState[]> = {
  draft: ['validated', 'rejected'],
  validated: ['confirmed', 'rejected'],
  confirmed: ['submitted', 'cancelled', 'rejected'],
  submitted: ['acknowledged', 'rejected'],
  acknowledged: ['partially_filled', 'filled', 'cancelled', 'expired'],
  partially_filled: ['partially_filled', 'filled', 'cancelled', 'expired'],
  filled: [],
  cancelled: [],
  rejected: [],
  expired: [],
};

/** States with no outgoing transitions — the order is done. */
export const TERMINAL_STATES: ReadonlySet<OrderState> = new Set(
  (Object.keys(TRANSITIONS) as OrderState[]).filter((s) => TRANSITIONS[s].length === 0),
);

export function isTerminal(state: OrderState): boolean {
  return TERMINAL_STATES.has(state);
}

/** The states reachable from `from` in one step. */
export function nextStates(from: OrderState): OrderState[] {
  return [...TRANSITIONS[from]];
}

export function canTransition(from: OrderState, to: OrderState): boolean {
  return TRANSITIONS[from]?.includes(to) ?? false;
}

export class IllegalTransitionError extends Error {
  constructor(
    readonly from: OrderState,
    readonly to: OrderState,
  ) {
    super(`Illegal order transition: ${from} → ${to}`);
    this.name = 'IllegalTransitionError';
  }
}

/** Throw unless `from → to` is a legal transition. */
export function assertTransition(from: OrderState, to: OrderState): void {
  if (!canTransition(from, to)) throw new IllegalTransitionError(from, to);
}
