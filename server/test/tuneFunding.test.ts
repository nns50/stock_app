import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockAccountState = vi.fn();
vi.mock('../src/providers/webull/accountState', () => ({
  webullAccountState: (...args: unknown[]) => mockAccountState(...args),
}));

import { tuneBuyingPower } from '../src/services/autotrading/tuneFunding';
import { AutotradeConfig } from '../src/db/autotradeConfig';

// The real 2026-08-27 payload: day BP is twice overnight, and option BP is a
// separate, far smaller pool.
const DAY_BP = 8_644.72;
const OVERNIGHT_BP = 4_322.36;
const OPTION_BP = 471.41;

const cfg = (over: Partial<AutotradeConfig> = {}): AutotradeConfig =>
  ({ liveAccountId: 'ACC1', liveDayBuyingPowerUsd: 0, ...over }) as AutotradeConfig;

const okState = (over: Record<string, unknown> = {}) => ({
  ok: true,
  state: { buyingPowerUsd: OVERNIGHT_BP, dayBuyingPowerUsd: DAY_BP },
  optionBuyingPowerUsd: OPTION_BP,
  ...over,
});

describe('tuneBuyingPower', () => {
  beforeEach(() => mockAccountState.mockReset());

  it('feeds the tune a buying power at all — the wiring that was missing', () => {
    // Originally the guard on a plumbed-but-dead bound. The bound is gone
    // (2026-09-05 — it froze the caps out of re-anchoring; see
    // deriveDollarCaps), but the figure still has to arrive: computeTargetTune
    // warns when the cap it is about to store is above what today can fund.
    mockAccountState.mockResolvedValue(okState());
    return expect(tuneBuyingPower(cfg())).resolves.toEqual({ buyingPowerUsd: DAY_BP });
  });

  it('does NOT return option BP — nothing downstream has a use for it', async () => {
    // The options cap deliberately tracks the equity cap, so there is no
    // options-side warning to raise; returning option BP would only invite
    // someone to bind a stored cap to a figure the re-anchor cannot see.
    mockAccountState.mockResolvedValue(okState());
    expect(await tuneBuyingPower(cfg())).not.toHaveProperty('optionBuyingPowerUsd');
  });

  it('prefers DAY buying power — these caps gate intraday entries', async () => {
    mockAccountState.mockResolvedValue(okState());
    const out = await tuneBuyingPower(cfg());
    expect(out.buyingPowerUsd).toBe(DAY_BP);
    expect(out.buyingPowerUsd).not.toBe(OVERNIGHT_BP);
  });

  it('falls back to overnight BP when the broker reports no day figure', async () => {
    mockAccountState.mockResolvedValue(okState({ state: { buyingPowerUsd: OVERNIGHT_BP } }));
    expect((await tuneBuyingPower(cfg())).buyingPowerUsd).toBe(OVERNIGHT_BP);
  });

  it("honours the operator's own day-BP ceiling when one is set", async () => {
    mockAccountState.mockResolvedValue(okState());
    const out = await tuneBuyingPower(cfg({ liveDayBuyingPowerUsd: 5_000 }));
    expect(out.buyingPowerUsd).toBe(5_000);
  });

  it('never lets that ceiling RAISE the broker figure', async () => {
    mockAccountState.mockResolvedValue(okState());
    const out = await tuneBuyingPower(cfg({ liveDayBuyingPowerUsd: 99_999 }));
    expect(out.buyingPowerUsd).toBe(DAY_BP);
  });

  it('fails soft on no live account — never calls the broker', async () => {
    expect(await tuneBuyingPower(cfg({ liveAccountId: null }))).toEqual({});
    expect(mockAccountState).not.toHaveBeenCalled();
  });

  it('fails soft on a broker error, rather than failing the tune', async () => {
    // Soft failure costs one warning now, not a different patch — the caps
    // derive identically with or without this number.
    mockAccountState.mockResolvedValue({ ok: false, error: 'nope' });
    expect(await tuneBuyingPower(cfg())).toEqual({});
  });

  it('fails soft when reading the payload blows up', async () => {
    // A malformed response rather than a clean error: the guard is a try/catch
    // around the whole read, so a field that explodes on access must still
    // leave the tune deriving caps exactly as it did before.
    mockAccountState.mockResolvedValue({
      ok: true,
      get state(): never {
        throw new Error('malformed payload');
      },
    });
    expect(await tuneBuyingPower(cfg())).toEqual({});
  });

  it('omits the figure entirely when the broker reported no buying power', async () => {
    mockAccountState.mockResolvedValue({ ok: true, state: {} });
    expect(await tuneBuyingPower(cfg())).toEqual({});
  });
});
