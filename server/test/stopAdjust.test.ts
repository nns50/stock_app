import { describe, it, expect, beforeAll } from 'vitest';
import { evaluateStopAdjust, StopAdjustPosition } from '../src/services/autotrading/stopAdjust';
import { initDb } from '../src/db';
import { createPosition, updatePosition, ratchetPositionStop } from '../src/db/positions';
import type { DailyTargetStatus } from '../src/services/autotrading/dailyTarget';

beforeAll(() => initDb());

const cfg = {
  liveTrailingEnabled: true,
  breakevenTriggerRMultiple: 1,
  trailStartRMultiple: 1,
  trailStopRMultiple: 1.5,
  // Off in the baseline fixture, so every existing case still describes the
  // breakeven/trail rules alone. Its own describe block turns it on.
  dayProtectiveStopEnabled: false,
  giveBackFloorPct: 1,
};

/** Long: entry 100, stop 96 => $4 of risk per share, so 1R = $4. */
const long = (over: Partial<StopAdjustPosition> = {}): StopAdjustPosition => ({
  side: 'long',
  entryPrice: 100,
  stopPrice: 96,
  initialStopPrice: 96,
  bestPriceSinceEntry: 100,
  remainingQuantity: 10,
  ...over,
});

/** Short mirror: entry 100, stop 104. */
const short = (over: Partial<StopAdjustPosition> = {}): StopAdjustPosition =>
  long({ side: 'short', stopPrice: 104, initialStopPrice: 104, ...over });

describe('evaluateStopAdjust', () => {
  it('is off unless liveTrailingEnabled — the three R settings alone must not arm it', () => {
    // All three are already non-zero in production (1 / 1 / 1.5) from the
    // paper-only era, so reusing them as the switch would have armed live
    // trailing stops the moment this deployed.
    const d = evaluateStopAdjust(long(), 110, { ...cfg, liveTrailingEnabled: false });
    expect(d.adjust).toBe(false);
    expect(d.detail).toMatch(/off/);
  });

  it('does nothing below the trigger', () => {
    // +3 on $4 of risk = 0.75R, under the 1R breakeven bar.
    const d = evaluateStopAdjust(long(), 103, cfg);
    expect(d.adjust).toBe(false);
    expect(d.rMultiple).toBe(0.75);
  });

  it('moves the stop to breakeven at the breakeven trigger', () => {
    // +4 = exactly 1R. Trailing also starts at 1R but hangs 1.5R (=$6) below
    // the best price of 104, i.e. 98 — worse than breakeven, so breakeven wins.
    const d = evaluateStopAdjust(long(), 104, cfg);
    expect(d).toMatchObject({ adjust: true, newStop: 100, kind: 'breakeven', rMultiple: 1 });
  });

  it('hands over to the trail once it overtakes breakeven', () => {
    // +12 = 3R. Trail sits 1.5R ($6) under the best price 112 => 106, which
    // beats breakeven's 100.
    const d = evaluateStopAdjust(long({ stopPrice: 100 }), 112, cfg);
    expect(d).toMatchObject({ adjust: true, newStop: 106, kind: 'trail', rMultiple: 3 });
  });

  it('trails the BEST price seen, not the current one — it does not give back on a pullback', () => {
    // Ran to 120 earlier, now back at 118. The trail stays anchored to 120, so
    // the stop is 120 - 6 = 114 rather than the 112 it would be if it followed
    // the current price down.
    const d = evaluateStopAdjust(long({ stopPrice: 106, bestPriceSinceEntry: 120 }), 118, cfg);
    expect(d).toMatchObject({ adjust: true, newStop: 114, kind: 'trail' });
    expect(d.bestPrice).toBe(120); // unchanged by the lower current price
  });

  it('NEVER loosens a stop, whatever the rules propose', () => {
    // Stop already ratcheted to 114 by an earlier peak; price has fallen back
    // so both candidates are now worse. The stop must not follow it down.
    const d = evaluateStopAdjust(long({ stopPrice: 114, bestPriceSinceEntry: 120 }), 108, cfg);
    expect(d.adjust).toBe(false);
    expect(d.newStop).toBeNull();
  });

  it('measures R against the INITIAL stop, never the ratcheted one', () => {
    // Stop already at 106, but risk is still measured off the original 96 =>
    // $4. At 112 that is 3R, so the trail is 112 - 6 = 106 — no change.
    // Were R measured off the CURRENT stop, risk would read as 100-106 and
    // every reading would be wrong.
    const d = evaluateStopAdjust(long({ stopPrice: 106, bestPriceSinceEntry: 112 }), 112, cfg);
    expect(d.rMultiple).toBe(3);
    expect(d.adjust).toBe(false); // 106 is exactly where it already is
  });

  it('mirrors for a short', () => {
    // Down 4 from 100 on $4 of risk = 1R => breakeven.
    expect(evaluateStopAdjust(short(), 96, cfg)).toMatchObject({ adjust: true, newStop: 100, kind: 'breakeven' });
    // Down 12 = 3R; trail sits 1.5R ($6) ABOVE the best (lowest) price 88 => 94.
    expect(evaluateStopAdjust(short({ stopPrice: 100 }), 88, cfg)).toMatchObject({
      adjust: true,
      newStop: 94,
      kind: 'trail',
    });
    // Wrong way: no ratchet.
    expect(evaluateStopAdjust(short(), 106, cfg).adjust).toBe(false);
  });

  it('refuses to place a stop through the current price', () => {
    // Ran to 120, then fell all the way back to 112. The trail is still
    // anchored at 120 - 6 = 114, which is now ABOVE the price: placing it
    // would fill instantly, a market exit wearing a stop's clothing. Hold the
    // existing stop and re-evaluate next tick instead.
    //
    // Only reachable on a pullback — while the best price IS the current
    // price, the trail sits a full trail distance below it by construction.
    const d = evaluateStopAdjust(long({ stopPrice: 106, bestPriceSinceEntry: 120 }), 112, cfg);
    expect(d.adjust).toBe(false);
    expect(d.detail).toMatch(/through the price/);
    expect(d.bestPrice).toBe(120); // still tracked, so the next tick can act
  });

  it('rounds to the cent grid, and only ever toward a tighter stop', () => {
    // Webull rejects any price off the $0.01 grid. Rounding a long's stop UP
    // can only tighten it; rounding down could loosen it by a fraction.
    const d = evaluateStopAdjust(long({ entryPrice: 100.005, stopPrice: 96, initialStopPrice: 96 }), 104.5, cfg);
    expect(d.adjust).toBe(true);
    expect(d.newStop).toBe(100.01); // ceil, not 100.00
    expect(Number.isInteger(Math.round(d.newStop! * 100))).toBe(true);
  });

  it('never ratchets a position it cannot measure', () => {
    expect(evaluateStopAdjust(long({ stopPrice: null }), 110, cfg).adjust).toBe(false);
    // No initial stop: a manual/imported row. Guessing the denominator from a
    // stop that may already have moved is how R silently becomes wrong.
    const noInit = evaluateStopAdjust(long({ initialStopPrice: null }), 110, cfg);
    expect(noInit.adjust).toBe(false);
    expect(noInit.detail).toMatch(/initial stop/);
    // Degenerate risk, and unusable prices.
    expect(evaluateStopAdjust(long({ initialStopPrice: 100 }), 110, cfg).adjust).toBe(false);
    expect(evaluateStopAdjust(long(), 0, cfg).adjust).toBe(false);
    expect(evaluateStopAdjust(long(), NaN, cfg).adjust).toBe(false);
  });

  it('each rule can be disabled on its own', () => {
    // Breakeven only: at 3R the trail would have moved the stop to 106, but
    // with trailStartRMultiple 0 the stop stays at the breakeven 100.
    const beOnly = { ...cfg, trailStartRMultiple: 0 };
    expect(evaluateStopAdjust(long({ stopPrice: 100 }), 112, beOnly).adjust).toBe(false);
    expect(evaluateStopAdjust(long(), 104, beOnly)).toMatchObject({ adjust: true, newStop: 100, kind: 'breakeven' });

    // Trail only: at 1R breakeven would say 100, but with it disabled the
    // trail's own 104 - 6 = 98 is what applies — still a tightening of 96.
    const trailOnly = { ...cfg, breakevenTriggerRMultiple: 0 };
    expect(evaluateStopAdjust(long(), 104, trailOnly)).toMatchObject({ adjust: true, newStop: 98, kind: 'trail' });

    // A start with no distance is not a trail at all.
    expect(evaluateStopAdjust(long({ stopPrice: 100 }), 112, { ...cfg, trailStopRMultiple: 0 }).adjust).toBe(false);
  });

  it('maintains the water mark even on cycles it does not fire', () => {
    // The trail hangs off this number, so it has to be right on every cycle,
    // not just the ones that move the stop.
    const d = evaluateStopAdjust(long(), 102, cfg); // 0.5R — no trigger
    expect(d.adjust).toBe(false);
    expect(d.bestPrice).toBe(102);
  });
});

// ---------------------------------------------------------------------------
// The initial-stop seeding bug, found live on 2026-08-26 (the first session
// with trailing enabled): not one ratchet fired all day, on any position.
//
// Autotrade's live positions are created by the BROKER SYNC, which cannot know
// the intended stop, so the row lands with no stop and initial_stop_price
// seeds null. Adoption then supplies the real stop via updatePosition, which
// wrote stop_price and left initial_stop_price null — so evaluateStopAdjust
// refused with "no initial stop recorded" before reaching any broker call.
// Adoption is the NORMAL path, so the feature was inert on exactly the
// positions it was built for.
// ---------------------------------------------------------------------------
describe('initial stop seeding — the adoption path', () => {
  it('seeds the initial stop when a stopless position is first given one', () => {
    // Exactly the live sequence: sync inserts with no stop, adoption sets it.
    const created = createPosition({
      assetType: 'stock',
      symbol: 'ADOPT',
      side: 'long',
      quantity: 9,
      entryPrice: 145.11,
      entryDate: '2026-08-26',
      tags: ['autotrade', 'live'],
    });
    expect(created.stopPrice).toBeNull();
    expect(created.initialStopPrice).toBeNull(); // nothing to snapshot yet

    const adopted = updatePosition(created.id, { stopPrice: 141.33, targetPrice: 152.2 })!;
    expect(adopted.stopPrice).toBe(141.33);
    expect(adopted.initialStopPrice).toBe(141.33); // <- the fix

    // And it is now measurable, which is the whole point.
    const d = evaluateStopAdjust(adopted, 149.0, cfg);
    expect(d.rMultiple).toBeGreaterThan(1);
    expect(d.adjust).toBe(true);
  });

  it('never overwrites an initial stop that already exists', () => {
    // A later stop edit must not move the denominator — every R reading on the
    // position is measured against it.
    const p = createPosition({
      assetType: 'stock',
      symbol: 'KEEPINIT',
      side: 'long',
      quantity: 10,
      entryPrice: 100,
      entryDate: '2026-08-26',
      stopPrice: 96,
    });
    expect(p.initialStopPrice).toBe(96);

    const moved = updatePosition(p.id, { stopPrice: 98 })!;
    expect(moved.stopPrice).toBe(98);
    expect(moved.initialStopPrice).toBe(96); // unchanged
  });

  it('a ratchet does not come through updatePosition, so it cannot reseed', () => {
    const p = createPosition({
      assetType: 'stock',
      symbol: 'RATCHSEED',
      side: 'long',
      quantity: 10,
      entryPrice: 100,
      entryDate: '2026-08-26',
      stopPrice: 96,
    });
    const after = ratchetPositionStop(p.id, 100)!;
    expect(after.stopPrice).toBe(100);
    expect(after.initialStopPrice).toBe(96); // denominator still the entry stop
  });
});

// ---------------------------------------------------------------------------
// The day-protective stop. Motivated by ANF on 2026-08-26: entered at 145.11
// with a 141.33 stop and 9 shares while the day was ~+1.6%, against a 1%
// give-back floor. A stop-out would have cost $34 and put the day at 0% —
// under the floor, so the guard would only have halted AFTER the damage.
//
// The design constraint that matters: it must not cost wins. So it moves the
// stop ONLY when the current one would breach the floor, and only as far as
// the floor requires — never to breakeven, which would scratch every trade
// that dips and recovers.
// ---------------------------------------------------------------------------
describe('day-protective stop', () => {
  const dpCfg = { ...cfg, dayProtectiveStopEnabled: true, giveBackFloorPct: 1 };

  /** A day up `gainPct` on a 2103.43 baseline, guard armed. */
  const day = (gainPct: number, armed = true): DailyTargetStatus => ({
    active: true,
    reached: false,
    giveBackArmed: armed,
    giveBackHalted: false,
    entriesHalted: false,
    baselineEquityUsd: 2103.43,
    currentEquityUsd: 2103.43 * (1 + gainPct / 100),
  });

  /** ANF as it actually was. 1R = 3.78/share. */
  const anf = (over = {}) => ({
    side: 'long' as const,
    entryPrice: 145.11,
    stopPrice: 141.33,
    initialStopPrice: 141.33,
    bestPriceSinceEntry: 145.11,
    remainingQuantity: 9,
    ...over,
  });

  it('tightens only to the floor, NOT to breakeven — the trade keeps room', () => {
    // Day +1.6% ($2137), floor 1% ($2124.46) => $12.5 of headroom over 9
    // shares = ~$1.39/share, so the stop lands ~143.72: well below entry.
    const d = evaluateStopAdjust(anf(), 146.5, dpCfg, day(1.6));
    expect(d.adjust).toBe(true);
    expect(d.kind).toBe('day_protective');
    expect(d.newStop!).toBeGreaterThan(143.0);
    expect(d.newStop!).toBeLessThan(144.5);
    expect(d.newStop!).toBeLessThan(145.11); // NOT breakeven
    expect(d.newStop!).toBeGreaterThan(141.33); // but tighter than the original
  });

  it('would NOT have scratched the real ANF trade', () => {
    // ANF never traded below its 145.11 entry before running to 152.20. The
    // protective stop sits under that, so the winner survives it.
    const d = evaluateStopAdjust(anf(), 146.5, dpCfg, day(1.6));
    expect(d.newStop!).toBeLessThan(145.11);
  });

  it('does NOTHING while the give-back guard is unarmed — a normal day is untouched', () => {
    // This is what keeps the rule near-free: on most days it never fires.
    const d = evaluateStopAdjust(anf(), 146.5, dpCfg, day(1.6, false));
    expect(d.adjust).toBe(false);
  });

  it('does nothing when the existing stop is already safe', () => {
    // Day well ahead: a full stop-out still leaves it above the floor, so the
    // original stop stands. The common case once a day is banked.
    const d = evaluateStopAdjust(anf(), 146.5, dpCfg, day(5.0));
    expect(d.adjust).toBe(false);
  });

  it('declines rather than squeezing the stop into the noise', () => {
    // Barely above the floor: the "required" stop would sit almost at entry,
    // inside ordinary intraday movement. Protecting the day is not worth
    // turning the position into a coin flip — leave the original stop.
    const d = evaluateStopAdjust(anf(), 146.5, dpCfg, day(1.02));
    expect(d.adjust).toBe(false);
  });

  it('does nothing once the day is already at or under the floor', () => {
    // That is the give-back guard's job, not this rule's.
    expect(evaluateStopAdjust(anf(), 146.5, dpCfg, day(0.5)).adjust).toBe(false);
    expect(evaluateStopAdjust(anf(), 146.5, dpCfg, day(1.0)).adjust).toBe(false);
  });

  it('is off unless its own flag is set, and needs a measurable day', () => {
    expect(evaluateStopAdjust(anf(), 146.5, cfg, day(1.6)).adjust).toBe(false); // flag off
    expect(evaluateStopAdjust(anf(), 146.5, dpCfg, undefined).adjust).toBe(false); // no day
    expect(evaluateStopAdjust(anf(), 146.5, { ...dpCfg, giveBackFloorPct: 0 }, day(1.6)).adjust).toBe(false);
  });

  it('never loosens, and yields to a tighter breakeven or trail', () => {
    // The rule is one candidate among three; the most favourable still wins,
    // so it can only ever ADD protection, never remove any.
    const alreadyTight = anf({ stopPrice: 145.0, bestPriceSinceEntry: 152.0 });
    const d = evaluateStopAdjust(alreadyTight, 152.0, dpCfg, day(1.6));
    if (d.adjust) expect(d.newStop!).toBeGreaterThanOrEqual(145.0);
  });

  it('mirrors for a short', () => {
    const shortPos = anf({ side: 'short' as const, stopPrice: 148.89, initialStopPrice: 148.89 });
    const d = evaluateStopAdjust(shortPos, 143.5, dpCfg, day(1.6));
    expect(d.adjust).toBe(true);
    expect(d.kind).toBe('day_protective');
    expect(d.newStop!).toBeGreaterThan(145.11); // above entry for a short
    expect(d.newStop!).toBeLessThan(148.89); // tighter than the original
  });
});
