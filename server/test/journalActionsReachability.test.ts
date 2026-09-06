import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

// ---------------------------------------------------------------------------
// Every journal action a consumer FILTERS ON must be one some emitter actually
// WRITES.
//
// Found 2026-09-06. riskCheck.ts's portfolio snapshot derived `tradesToday` by
// filtering execution events for `action === 'order_placed'` — an action that
// has never been journaled once. The emitters are named `paper_order_placed`
// and `live_order_placed`; the consumer was never updated when they were.
// Production's own events endpoint says it outright, answering that query with
//   {"events":[],"actionsNeverSeen":["order_placed"]}
// so `tradesToday` was a permanent 0 and `max_trades_per_day` could never fail
// on the two preview endpoints reading that snapshot. Confirmed live:
// POST /api/autotrade/risk-check answered "max_trades_per_day passed=True —
// 0 placed vs 14/day" on demand.
//
// This is configReachability.test.ts's idea one layer over: that file asks
// whether a config field is READ, this one asks whether an event a reader is
// waiting for is ever WRITTEN. A filter on a string nothing emits is invisible
// — no error, no empty-result warning, just a rule that silently always passes.
//
// Deliberately a source scan and not a runtime assertion: the failure is an
// ABSENCE, and an absence has no behaviour to drive. It cannot prove an emitter
// is reachable at runtime, only that one exists to be reached — which is
// exactly the step that was missing.
// ---------------------------------------------------------------------------

const SRC = join(__dirname, '..', 'src');

function tsFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    return statSync(p).isDirectory() ? tsFiles(p) : name.endsWith('.ts') ? [p] : [];
  });
}

/** Comment lines stripped: the prose around these call sites names actions
 *  while explaining them, and a scan that reads prose measures the prose. */
function code(path: string): string {
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter((l) => {
      const t = l.trimStart();
      return !t.startsWith('//') && !t.startsWith('*') && !t.startsWith('/*');
    })
    .join('\n');
}

const ACTION = /'([a-z0-9_]+)'/g;
const files = tsFiles(SRC);

/** `const NAME = '...'` / `const NAME = [...]` per file — both call sites reach
 *  for actions through named constants as often as through literals. */
function constants(src: string): Map<string, string | string[]> {
  const out = new Map<string, string | string[]>();
  for (const m of src.matchAll(/const\s+([A-Za-z0-9_]+)\s*(?::[^=]*)?=\s*'([a-z0-9_]+)'/g)) out.set(m[1], m[2]);
  for (const m of src.matchAll(/const\s+([A-Za-z0-9_]+)\s*(?::[^=]*)?=\s*\[([^\]]*)\]/g)) {
    out.set(
      m[1],
      [...m[2].matchAll(ACTION)].map((x) => x[1]),
    );
  }
  return out;
}

function scan(): { emitted: Set<string>; consumed: Map<string, Set<string>> } {
  const emitted = new Set<string>();
  const consumed = new Map<string, Set<string>>();
  const note = (a: string, f: string) => consumed.set(a, (consumed.get(a) ?? new Set()).add(f));

  for (const f of files) {
    const src = code(f);
    const consts = constants(src);

    // EMIT side. Everything to the end of the `action:` line, so a ternary
    // (`action: role === 'exit' ? 'a' : 'b'`) counts BOTH of its branches —
    // liveExecute writes two materialization actions exactly that way, and a
    // literal-only regex reports them as dead when they are not.
    for (const m of src.matchAll(/action:\s*([^\n]*)/g)) {
      const seg = m[1];
      // Two things that look like an emit and are not, both of which would let
      // a dead filter hide from this scan by vouching for itself.
      //   1. A TYPE ANNOTATION (`{ action: string }`) is a shape, not a write.
      //   2. Anything after a `.action` READ on the same line belongs to the
      //      consumer, not to an emitter — so the segment is truncated there.
      // Note this cannot simply reject `===`: liveExecute writes two of these
      // through a ternary whose CONDITION contains one
      // (`action: meta.role === 'exit' ? … : …`), and rejecting that reports
      // two live emitters as dead.
      if (/^(?:string|number|boolean|unknown|any)\b/.test(seg.trim())) continue;
      const emitSeg = seg.split(/\.action\b/)[0];
      for (const a of emitSeg.matchAll(ACTION)) emitted.add(a[1]);
      for (const id of emitSeg.matchAll(/\b([A-Z][A-Za-z0-9_]*)\b/g)) {
        const v = consts.get(id[1]);
        if (typeof v === 'string') emitted.add(v);
      }
    }

    // CONSUME side: `actions: [...]` filters and `e.action === '...'` compares.
    for (const m of src.matchAll(/actions:\s*\[([^\]]*)\]/g)) {
      const body = m[1];
      for (const a of body.matchAll(ACTION)) note(a[1], f);
      for (const id of body.matchAll(/\b([A-Z][A-Z0-9_]{2,})\b/g)) {
        const v = consts.get(id[1]);
        for (const a of typeof v === 'string' ? [v] : (v ?? [])) note(a, f);
      }
    }
    for (const m of src.matchAll(/\.action\s*===\s*'([a-z0-9_]+)'/g)) note(m[1], f);
  }
  return { emitted, consumed };
}

describe('journal action reachability', () => {
  const { emitted, consumed } = scan();

  it('finds both sides of the wiring at all — a scan that matches nothing proves nothing', () => {
    // If a refactor changes how actions are written or read, the regexes above
    // go quiet and the guard passes vacuously. These floors are what make a
    // silent scan fail loudly instead.
    expect(emitted.size).toBeGreaterThan(80);
    expect(consumed.size).toBeGreaterThan(20);
  });

  it('never filters on an action no emitter writes', () => {
    const dead = [...consumed.entries()]
      .filter(([a]) => !emitted.has(a))
      .map(([a, fs]) => `${a} (read in ${[...fs].map((f) => f.split('/').pop()).join(', ')})`);
    expect(dead).toEqual([]);
  });

  it('knows the specific action that started this — order_placed is not an emitter', () => {
    // Pinned rather than left implicit: if someone adds an `order_placed`
    // emitter later, this fails and they get to decide DELIBERATELY whether the
    // preview should count it, instead of a dead filter quietly coming alive.
    expect(emitted.has('order_placed')).toBe(false);
  });
});
