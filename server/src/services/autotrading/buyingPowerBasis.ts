import { AutotradeConfig } from '../../db/autotradeConfig';
import { AccountState } from '../trading/guardrails';

/**
 * Which buying-power figure an opening order is bound by, and where it came
 * from.
 *
 * Split out of `liveExecute.ts` on 2026-09-14 so every path that needs to
 * answer "what can this account actually open right now" calls ONE function.
 * Two paths ask: the live sizer (`fundableMaxQuantity`, real money) and the
 * tune preview's funding warning (`tuneFunding.ts`, advice). They used to
 * derive it separately and disagreed on all three of netting, precedence and
 * the cash bound below — the divergence CLAUDE.md's "agree by construction"
 * rule exists to stop.
 *
 * THE THREE POOLS, and why the smallest is the one that matters.
 *
 * `buyingPowerUsd` is the broker's OVERNIGHT figure — what a position can hold
 * without being closed by the bell. autotrade's live equity loop is the one
 * caller that always IS flat by the bell (endOfDayFlattenMinutes), so it is
 * the one caller entitled to the larger DAY figure.
 *
 * `liveDayBuyingPowerUsd` is a CAP on the day figure, not a value: 0 (the
 * default) uses the broker's figure in full, and a positive number refuses to
 * use more than that however much the broker offers.
 *
 * None of the three is what the broker checks when ACCEPTING an opening order
 * — see the boundary note on the function below, and buyingPowerRefusals.ts.
 */
export interface BuyingPowerBasis {
  /** The figure the sizer is bound by — what `fundableMaxQuantity` receives. */
  usedUsd: number;
  /** Which field it came from. `'day'` means the broker's DAY-TRADING figure
   *  was larger than the overnight one and won. */
  source: 'overnight' | 'day';
  /** The broker's overnight figure, always present. */
  overnightUsd: number;
  /** The broker's day figure, when it reported one. */
  brokerDayUsd: number | null;
  /** `liveDayBuyingPowerUsd` when it capped the day figure, else null. */
  ceilingUsd: number | null;
  /** Exposure the day figure was netted against. */
  exposureUsd: number;
  /** The account's CASH balance, when the broker reported one. Carried for the
   *  journal; nothing decides on it — margin is real on this account
   *  ($6,249.48 held against $3,497.62 of cash on 2026-09-14). */
  cashBalanceUsd: number | null;
  /** The ceiling learned from today's refusals, when there was one — dollars of
   *  ORDER NOTIONAL, NOT of buying power, which is why it is carried here and
   *  applied elsewhere. `usedUsd` answers "how much pool is there"; the ceiling
   *  answers "how big an order will this broker actually accept today". The
   *  clamp happens on the final quantity in liveExecute, after the probation
   *  multiplier, because that is the notional the broker judges — applying it
   *  to the pool instead would let probation halve an already-bounded order and
   *  the book would converge downward for no reason. */
  learnedCeilingUsd: number | null;
}

/**
 * THE BOUNDARY, measured (2026-09-14, the trial sizing's first session).
 *
 * Five opening orders were refused by the broker — "Buying power is
 * insufficient" — while the app's own sizer was happy. The full record, and
 * the two wrong readings it rules out, live in buyingPowerRefusals.ts. The one
 * fact this function has to act on:
 *
 *   At 09:57 the book was FLAT — COIN and NOW had both been sold — so
 *   `exposureUsd` was back to 0 and the day branch below handed the sizer the
 *   whole $13,990.49. The broker refused $3,720.12.
 *
 * Closing a position returns the app's EXPOSURE to zero. It does not return
 * the broker's pool: that is consumed by purchases. So `broker - exposure` is
 * an upper bound the broker does not honour, and the two sides of that
 * subtraction are not the same kind of thing — a live mark-to-market value
 * against a pool spent at cost and not credited back on a sale.
 *
 * Rather than guess the broker's formula from ten orders — the mistake that
 * cost four separate theories — the day figure stays exactly as it is, and a
 * LEARNED CEILING (buyingPowerRefusals.ts) clamps the finished order instead.
 *
 * UNITS, and why the ceiling is only CARRIED here rather than applied.
 * `usedUsd`, `overnightUsd`, `brokerDayUsd` and `ceilingUsd` are all DOLLARS OF
 * PURCHASING POWER FOR ONE OPENING ORDER, which is why they can be compared to
 * each other. `learnedCeilingUsd` is dollars of ORDER NOTIONAL — a different
 * quantity, judged at a different point — so it rides along for the journal
 * and is applied to the final quantity in liveExecute, after probation.
 */
export function buyingPowerBasis(
  state: AccountState,
  cfg: AutotradeConfig,
  learnedCeilingUsd?: number | null,
): BuyingPowerBasis {
  // A broker read that named no pool at all reads as 0, not NaN/undefined: the
  // honest answer to "what can this fund" is nothing, and a NaN would travel
  // silently into the sizer and out the other side as an unbounded order.
  const overnightUsd = Number.isFinite(state.buyingPowerUsd) ? state.buyingPowerUsd : 0;
  const broker = state.dayBuyingPowerUsd;
  const cashBalanceUsd = state.cashBalanceUsd ?? null;
  const base: BuyingPowerBasis = {
    usedUsd: overnightUsd,
    source: 'overnight',
    overnightUsd,
    brokerDayUsd: broker ?? null,
    ceilingUsd: null,
    exposureUsd: state.exposureUsd,
    cashBalanceUsd,
    learnedCeilingUsd: learnedCeilingUsd ?? null,
  };

  let margin = base;
  // Exposure must be a real number for the day branch to mean anything: the
  // broker's day figure is GROSS, and netting it against a NaN would quietly
  // fall through to the overnight figure with nothing said. A read that cannot
  // say what is deployed does not get to use the larger pool.
  const exposureKnown = Number.isFinite(state.exposureUsd);
  if (broker !== undefined && broker > 0 && exposureKnown) {
    const capped = cfg.liveDayBuyingPowerUsd > 0;
    const ceiling = capped ? Math.min(broker, cfg.liveDayBuyingPowerUsd) : broker;
    const availableIntraday = Math.max(0, ceiling - state.exposureUsd);
    // Ties stay 'overnight': the day figure only WON if it was strictly larger,
    // and reporting a tie as a day read would overstate how often it matters.
    margin =
      availableIntraday > overnightUsd
        ? {
            ...base,
            usedUsd: availableIntraday,
            source: 'day',
            ceilingUsd: capped ? ceiling : null,
          }
        : { ...base, ceilingUsd: capped ? ceiling : null };
  }

  return margin;
}
