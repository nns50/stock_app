import { vi } from 'vitest';
import type { WebullOrderStatus } from '../../src/providers/webull/orders';

type SingleLookup = (accountId: string, clientOrderId: string) => Promise<WebullOrderStatus>;

/**
 * Derive a `webullOrderStatusBatch` mock from a per-order `webullOrderStatus`
 * mock.
 *
 * The reconcilers ask the broker about every pending order in one pair of list
 * fetches rather than one order at a time (the order-query endpoints allow only
 * 2 requests per 2 seconds). A test, though, wants to say something about ONE
 * order — "this one came back FILLED". Delegating lets tests keep expressing
 * themselves per-order while the code under test still runs the batched path it
 * actually uses in production.
 *
 * The batch's own behaviour — fetching each list once, and isolating a failure
 * to the orders it actually affects — is covered directly in
 * webullOrders.test.ts against a mocked transport, which is where that logic
 * belongs.
 */
export function batchFromSingle(single: SingleLookup) {
  return vi.fn(async (accountId: string, clientOrderIds: string[]) => {
    const out = new Map<string, WebullOrderStatus>();
    for (const id of clientOrderIds) out.set(id, await single(accountId, id));
    return out;
  });
}
