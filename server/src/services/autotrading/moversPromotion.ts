import { AutotradeConfig } from '../../db/autotradeConfig';
import { isExcluded } from '../../db/autotradeExclusions';
import { logAutotradeEvent } from '../../db/autotradeEvents';
import {
  countAutoPromoted,
  countRecentMoverOccurrences,
  isAutoPromoted,
  recordAutoPromotion,
  recordMoverOccurrence,
} from '../../db/moversPromotion';
import { addSymbols, listUniverseSymbols } from '../../db/universe';
import { ScreenCandidate } from './screen';

// ---------------------------------------------------------------------------
// Movers auto-promotion (docs/AUTOTRADING_SPEC.md — the 2026-07-10
// universe-widening fix's explicitly separate follow-up). The screener
// already re-discovers Webull's movers every cycle, but a mover-sourced
// symbol is never persisted: it's scored, maybe traded, then forgotten, so a
// genuinely active name gets re-found (and re-scored from zero IV/history)
// every single day instead of earning a permanent spot in `universe`. This
// closes that gap: track recurrence, promote once a symbol proves itself
// over several distinct days.
//
// Deliberately called from the automatic loop tick only (loop.ts), never the
// manual "Run screen" route — this specifically addresses the AUTOMATED
// loop's own pigeon-holing, not manual screening activity.
// ---------------------------------------------------------------------------

export interface MoversPromotionResult {
  /** Movers-sourced, filters-passing symbols an occurrence was recorded for
   *  this cycle (deduped; already-recorded-today symbols are still listed
   *  here even though the DB write itself was a no-op). */
  recorded: string[];
  /** Symbols newly added to `universe` this cycle. */
  promoted: string[];
  /** Symbols that cleared the threshold but were blocked by the lifetime cap. */
  atCap: string[];
}

const EMPTY_RESULT: MoversPromotionResult = { recorded: [], promoted: [], atCap: [] };

/** Record today's occurrence for every movers-sourced candidate that passed
 *  screening, then promote any that have now cleared the recurrence
 *  threshold into the persistent universe — subject to the real-estate
 *  exclusion list and the lifetime growth cap, and never re-promoting a
 *  symbol this mechanism has already handled once (including one a user
 *  later removed from universe on purpose — see auto_promoted_symbols'
 *  schema comment in db/index.ts). */
export function processMoversForPromotion(
  candidates: ScreenCandidate[],
  cfg: Pick<
    AutotradeConfig,
    'autoPromoteMoversEnabled' | 'autoPromoteThreshold' | 'autoPromoteWindowDays' | 'autoPromoteMaxSymbols'
  >,
): MoversPromotionResult {
  const moversSymbols = Array.from(
    new Set(candidates.filter((c) => c.discoverySource === 'movers').map((c) => c.symbol.toUpperCase())),
  );
  if (!moversSymbols.length) return EMPTY_RESULT;

  for (const symbol of moversSymbols) recordMoverOccurrence(symbol);
  if (!cfg.autoPromoteMoversEnabled) return { recorded: moversSymbols, promoted: [], atCap: [] };

  const universeSet = new Set(listUniverseSymbols().map((s) => s.toUpperCase()));
  const promoted: string[] = [];
  const atCap: string[] = [];
  let autoPromotedCount = countAutoPromoted();

  for (const symbol of moversSymbols) {
    if (universeSet.has(symbol)) continue; // already in universe (seeded/user-added/already promoted)
    if (isAutoPromoted(symbol)) continue; // handled once already — never re-fight a user's later removal
    if (isExcluded(symbol)) continue; // real-estate exclusion still applies to auto-promotion

    const occurrences = countRecentMoverOccurrences(symbol, cfg.autoPromoteWindowDays);
    if (occurrences < cfg.autoPromoteThreshold) continue;

    if (autoPromotedCount >= cfg.autoPromoteMaxSymbols) {
      atCap.push(symbol);
      continue;
    }

    addSymbols([{ symbol }]);
    recordAutoPromotion(symbol);
    autoPromotedCount++;
    promoted.push(symbol);
    logAutotradeEvent({
      symbol,
      stage: 'screen',
      action: 'universe_auto_promoted',
      detail: { occurrences, windowDays: cfg.autoPromoteWindowDays, threshold: cfg.autoPromoteThreshold },
    });
  }

  return { recorded: moversSymbols, promoted, atCap };
}
