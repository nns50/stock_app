import { describe, it, expect, vi, beforeEach } from 'vitest';

// The snapshot call is the only I/O in this module. Default OFF (ok:false) so
// every case starts from "no OPRA answer" — today's behaviour — and arms it
// explicitly where a print is the point.
vi.mock('../src/providers/webull/optionQuotes', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/providers/webull/optionQuotes')>();
  return { ...actual, webullOptionQuotes: vi.fn(async () => ({ ok: false, quotes: [] })) };
});

import {
  OPTION_QUOTES_MAX_SYMBOLS,
  WEBULL_SNAPSHOT_BATCH_LIMIT,
  webullOptionQuotes,
} from '../src/providers/webull/optionQuotes';
import { CONTRACT_QUOTE_MAX_AGE_MS, freshTwoSidedPrint } from '../src/services/autotrading/optionsExitPricing';
import {
  overlayLiveQuotes,
  overlaySelectionQuotes,
  selectionCandidates,
} from '../src/services/autotrading/optionsSelectionQuotes';
import { OptionContract, OptionsChain } from '../src/providers/types';

const mockOptionQuotes = vi.mocked(webullOptionQuotes);

const NOW = Date.UTC(2026, 8, 22, 14, 35, 0);

function contract(strike: number, opts: Partial<OptionContract> = {}): OptionContract {
  return {
    symbol: `AAPL260925C${String(Math.round(strike * 1000)).padStart(8, '0')}`,
    underlying: 'AAPL',
    type: 'call',
    strike,
    expiration: '2026-09-25',
    bid: 2.9,
    ask: 3.1,
    mark: 3,
    volume: 500,
    openInterest: 1000,
    greeks: { delta: 0.45, iv: 0.4, computed: true },
    ...opts,
  };
}

function chainOf(calls: OptionContract[], underlyingPrice?: number, puts: OptionContract[] = []): OptionsChain {
  return { underlying: 'AAPL', expiration: '2026-09-25', underlyingPrice, calls, puts };
}

function range(from: number, to: number): number[] {
  const out: number[] = [];
  for (let s = from; s <= to; s++) out.push(s);
  return out;
}

beforeEach(() => {
  mockOptionQuotes.mockReset().mockResolvedValue({ ok: false, quotes: [] });
});

describe('selectionCandidates — the nearest-the-money set, capped at the snapshot batch', () => {
  it('returns every contract, in chain order, when the side fits under the cap', () => {
    const calls = [contract(105), contract(95), contract(100)];
    const picked = selectionCandidates(chainOf(calls, 100), 'call');
    expect(picked.map((c) => c.strike)).toEqual([105, 95, 100]);
    expect(picked).not.toBe(calls); // a copy, never the chain's own array
  });

  it('keeps the strikes nearest the underlying price out of 60, breaking the last tie by chain order', () => {
    const calls = range(70, 129).map((s) => contract(s));
    const picked = selectionCandidates(chainOf(calls, 100), 'call');
    expect(picked).toHaveLength(WEBULL_SNAPSHOT_BATCH_LIMIT);
    // 19 strikes within 9 of the money (91..109), plus the first of the two at
    // distance 10 in chain order: 90 comes before 110.
    expect(picked.map((c) => c.strike).sort((a, b) => a - b)).toEqual(range(90, 109));
    expect(picked[0].strike).toBe(100); // ordered nearest first
  });

  // THE BUG THIS FILE MISSED (2026-09-21). The cap used to be asserted against
  // a COPY of itself — `expect(OPTION_QUOTES_MAX_SYMBOLS).toBe(40)` — which is
  // true of any number the constant happens to hold. The number that had to be
  // right was the one the BROKER accepts, and it is 20: a batch of 40 comes
  // back `symbols size must be between 1 and 20.` with no quotes, so every
  // selection overlay from 2026-09-19 to 2026-09-21 was refused whole and fell
  // back to the delayed chain in silence.
  it('sizes the request to what ONE broker call accepts, never to the caller cap', () => {
    expect(WEBULL_SNAPSHOT_BATCH_LIMIT).toBeLessThanOrEqual(20);
    const calls = range(1, 60).map((s) => contract(s));
    const picked = selectionCandidates(chainOf(calls, 30), 'call');
    expect(
      picked.length,
      'the selection must fit in one snapshot call: the endpoint refuses a batch above its limit WHOLE, ' +
        'returning no quotes at all rather than the ones it could serve',
    ).toBeLessThanOrEqual(WEBULL_SNAPSHOT_BATCH_LIMIT);
    expect(OPTION_QUOTES_MAX_SYMBOLS).toBeGreaterThanOrEqual(WEBULL_SNAPSHOT_BATCH_LIMIT);
  });

  it('falls back to the chain delta nearest 0.50 when the chain carries no underlying price', () => {
    const calls = range(80, 120).map((s) => contract(s, { greeks: { delta: 0.5 + (100 - s) * 0.01 } }));
    const picked = selectionCandidates(chainOf(calls, undefined), 'call', 39);
    expect(picked.map((c) => c.strike).sort((a, b) => a - b)).toEqual(range(81, 119));
  });

  it('reads the puts for a put signal', () => {
    const puts = [contract(100, { type: 'put' })];
    expect(selectionCandidates(chainOf([contract(100)], 100, puts), 'put')).toEqual(puts);
  });
});

describe('overlayLiveQuotes — a fresh print replaces the numbers, nothing else moves', () => {
  it('overlays bid/ask/mark, last, volume, open interest and greeks from a fresh two-sided print', () => {
    const calls = [contract(100), contract(105)];
    const { contracts, rePriced, oldestAgeMs } = overlayLiveQuotes(
      calls,
      [
        {
          symbol: calls[0].symbol,
          bid: 3.9,
          ask: 4.1,
          last: 4.05,
          volume: 900,
          openInterest: 2000,
          delta: 0.5,
          iv: 0.42,
          quoteTime: NOW - 590,
        },
      ],
      NOW,
    );
    expect(rePriced).toBe(1);
    expect(oldestAgeMs).toBe(590);
    expect(contracts[0]).toMatchObject({
      strike: 100,
      bid: 3.9,
      ask: 4.1,
      mark: 4,
      last: 4.05,
      volume: 900,
      openInterest: 2000,
      greeks: { delta: 0.5, iv: 0.42, computed: false },
    });
    // The contract without a print is the same object; the input is never mutated.
    expect(contracts[1]).toBe(calls[1]);
    expect(calls[0].mark).toBe(3);
    expect(calls[0].greeks?.computed).toBe(true);
  });

  it('keeps the chain greeks, volume and OI when the print carries only a quote', () => {
    const calls = [contract(100)];
    const { contracts } = overlayLiveQuotes(calls, [{ symbol: calls[0].symbol, bid: 3.9, ask: 4.1 }], NOW);
    expect(contracts[0]).toMatchObject({
      bid: 3.9,
      ask: 4.1,
      mark: 4,
      volume: 500,
      openInterest: 1000,
      greeks: { delta: 0.45, iv: 0.4, computed: true },
    });
  });

  it('leaves a contract untouched on a stale print — the same freshness rule an order applies', () => {
    const calls = [contract(100)];
    const stale = { symbol: calls[0].symbol, bid: 3.9, ask: 4.1, quoteTime: NOW - CONTRACT_QUOTE_MAX_AGE_MS - 1 };
    const { contracts, rePriced, oldestAgeMs } = overlayLiveQuotes(calls, [stale], NOW);
    expect(contracts[0]).toBe(calls[0]);
    expect(rePriced).toBe(0);
    expect(oldestAgeMs).toBeNull();
    expect(freshTwoSidedPrint(stale, NOW).usable).toBe(false);
    // Exactly at the limit is still fresh.
    const edge = { ...stale, quoteTime: NOW - CONTRACT_QUOTE_MAX_AGE_MS };
    expect(overlayLiveQuotes(calls, [edge], NOW).rePriced).toBe(1);
  });

  it('leaves a contract untouched on a one-sided print', () => {
    const calls = [contract(100)];
    const { contracts, rePriced } = overlayLiveQuotes(
      calls,
      [{ symbol: calls[0].symbol, bid: 3.9, quoteTime: NOW }],
      NOW,
    );
    expect(contracts[0]).toBe(calls[0]);
    expect(rePriced).toBe(0);
  });

  it('takes a print with no timestamp as current and does not raise the age bound with it', () => {
    const calls = [contract(100), contract(105)];
    const { rePriced, oldestAgeMs } = overlayLiveQuotes(
      calls,
      [
        { symbol: calls[0].symbol, bid: 3.9, ask: 4.1 },
        { symbol: calls[1].symbol, bid: 1.9, ask: 2.1, quoteTime: NOW - 5_000 },
      ],
      NOW,
    );
    expect(rePriced).toBe(2);
    expect(oldestAgeMs).toBe(5_000);
  });

  it('matches symbols case-insensitively, as the snapshot upper-cases them', () => {
    const calls = [contract(100, { symbol: 'aapl260925c00100000' })];
    const { rePriced } = overlayLiveQuotes(calls, [{ symbol: 'AAPL260925C00100000', bid: 3.9, ask: 4.1 }], NOW);
    expect(rePriced).toBe(1);
  });
});

describe('overlaySelectionQuotes — one fetch, the chain unchanged without a fresh answer', () => {
  it('returns the same chain and a chain report when the snapshot answers ok:false', async () => {
    const chain = chainOf([contract(100), contract(105)], 100);
    const { chain: out, report } = await overlaySelectionQuotes(chain, 'call', NOW);
    expect(out).toBe(chain);
    expect(report).toEqual({
      selectionQuoteSource: 'chain',
      rePricedContracts: 0,
      quoteAgeMs: null,
      quotesRequested: 2,
      // WHY the fallback happened, so an overlay that is inert for two sessions
      // reads as refused rather than as "no OPRA answer today" (2026-09-21).
      selectionQuoteError: 'snapshot unavailable',
    });
    expect(mockOptionQuotes).toHaveBeenCalledWith([chain.calls[0].symbol, chain.calls[1].symbol]);
  });

  it('carries the broker’s own refusal into the report', async () => {
    mockOptionQuotes.mockResolvedValue({
      ok: false,
      quotes: [],
      error: 'symbols size must be between 1 and 20.',
    });
    const { report } = await overlaySelectionQuotes(chainOf([contract(100)], 100), 'call', NOW);
    expect(report.selectionQuoteError).toBe('symbols size must be between 1 and 20.');
  });

  it('says so when the snapshot answered but nothing in it was fresh', async () => {
    const calls = [contract(100)];
    mockOptionQuotes.mockResolvedValue({
      ok: true,
      quotes: [{ symbol: calls[0].symbol, bid: 3.9, ask: 4.1, quoteTime: NOW - CONTRACT_QUOTE_MAX_AGE_MS * 3 }],
    });
    const { report } = await overlaySelectionQuotes(chainOf(calls, 100), 'call', NOW);
    expect(report.selectionQuoteSource).toBe('chain');
    expect(report.selectionQuoteError).toMatch(/no fresh two-sided print/);
  });

  it('never throws on the OPRA leg — an error returns the chain unchanged', async () => {
    mockOptionQuotes.mockRejectedValue(new Error('socket hang up'));
    const chain = chainOf([contract(100)], 100);
    const { chain: out, report } = await overlaySelectionQuotes(chain, 'call', NOW);
    expect(out).toBe(chain);
    expect(report.selectionQuoteSource).toBe('chain');
    expect(report.selectionQuoteError).toBe('socket hang up');
  });

  it('sends one batch the broker will accept, and says how many it asked for', async () => {
    const chain = chainOf(
      range(70, 129).map((s) => contract(s)),
      100,
    );
    const { report } = await overlaySelectionQuotes(chain, 'call', NOW);
    const sent = mockOptionQuotes.mock.calls[0][0];
    expect(sent).toHaveLength(WEBULL_SNAPSHOT_BATCH_LIMIT);
    expect(new Set(sent).size).toBe(WEBULL_SNAPSHOT_BATCH_LIMIT);
    expect(report.quotesRequested).toBe(WEBULL_SNAPSHOT_BATCH_LIMIT);
  });

  it('re-prices the side from fresh prints and reports the oldest age, leaving the other side alone', async () => {
    const calls = [contract(100), contract(105), contract(110)];
    const puts = [contract(100, { type: 'put' })];
    const chain = chainOf(calls, 100, puts);
    mockOptionQuotes.mockResolvedValue({
      ok: true,
      quotes: [
        { symbol: calls[0].symbol, bid: 3.9, ask: 4.1, quoteTime: NOW - 100 },
        { symbol: calls[1].symbol, bid: 1.9, ask: 2.1, quoteTime: NOW - 4_000 },
      ],
    });
    const { chain: out, report } = await overlaySelectionQuotes(chain, 'call', NOW);
    expect(out).not.toBe(chain);
    expect(out.calls[0].mark).toBe(4);
    expect(out.calls[1].mark).toBe(2);
    expect(out.calls[2]).toBe(calls[2]);
    expect(out.puts).toBe(puts);
    expect(chain.calls[0].mark).toBe(3); // the input chain is untouched
    expect(report).toEqual({
      selectionQuoteSource: 'opra',
      rePricedContracts: 2,
      quoteAgeMs: 4_000,
      quotesRequested: 3,
    });
    expect(report.selectionQuoteError).toBeUndefined(); // no reason to give when it worked
  });

  it('overlays the puts for a put signal', async () => {
    const puts = [contract(100, { type: 'put' })];
    const chain = chainOf([contract(100)], 100, puts);
    mockOptionQuotes.mockResolvedValue({
      ok: true,
      quotes: [{ symbol: puts[0].symbol, bid: 2.4, ask: 2.6, quoteTime: NOW }],
    });
    const { chain: out, report } = await overlaySelectionQuotes(chain, 'put', NOW);
    expect(out.puts[0].mark).toBe(2.5);
    expect(out.calls).toBe(chain.calls);
    expect(report.rePricedContracts).toBe(1);
  });

  it('asks for nothing and reports nothing when the side is empty', async () => {
    const chain = chainOf([], 100);
    const { chain: out, report } = await overlaySelectionQuotes(chain, 'call', NOW);
    expect(out).toBe(chain);
    expect(report.quotesRequested).toBe(0);
    expect(mockOptionQuotes).not.toHaveBeenCalled();
  });
});
