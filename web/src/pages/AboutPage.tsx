import { ReactNode } from 'react';
import { CollapsibleCard, PageHeader } from '../components/ui';

function Section({ id, title, children }: { id: string; title: string; children: ReactNode }) {
  return (
    <CollapsibleCard id={`about.${id}`} title={title} headingLevel="h2">
      <div className="space-y-2 text-sm text-slate-300 leading-relaxed">{children}</div>
    </CollapsibleCard>
  );
}

function Term({ term, children }: { term: string; children: ReactNode }) {
  return (
    <div className="grid grid-cols-[120px_1fr] gap-3 py-1.5 border-b border-ink-700/50 last:border-0">
      <dt className="text-slate-200 font-medium">{term}</dt>
      <dd className="text-slate-400">{children}</dd>
    </div>
  );
}

// The eight scoring components, mirroring server/src/indicators/screener.ts so
// the page stays an accurate description of what the engine actually does.
const COMPONENTS: { name: string; weight: number; what: string }[] = [
  {
    name: 'Momentum',
    weight: 30,
    what: 'Average of the day’s % change and the distance of price above/below its 20- and 50-period moving averages, scaled so a ±5% move is a full score. Mirrored for shorts.',
  },
  {
    name: 'Rel. Volume',
    weight: 20,
    what: 'Today’s volume ÷ its recent average. 0.5× scores 0, the target (2×) scores 100 — unusual participation scores higher.',
  },
  {
    name: 'RSI',
    weight: 15,
    what: 'Closeness to a direction-aware “sweet spot” (60 for longs, 40 for shorts) within a ±25 band — not a raw overbought/oversold flag.',
  },
  {
    name: 'Volatility (ATR%)',
    weight: 10,
    what: 'Average True Range as a % of price, scaled so 5% is a full score. More daily range scores higher (it rewards tradeable movement, capped).',
  },
  {
    name: 'Gap',
    weight: 10,
    what: 'Overnight gap in the trade’s favor, scaled so a 3% favorable gap is a full score.',
  },
  {
    name: 'Trend',
    weight: 15,
    what: 'How many of three conditions hold: price vs the 20MA, price vs the 50MA, and 20MA vs 50MA alignment (0, 33, 67, or 100).',
  },
  {
    name: 'Rel. Strength',
    weight: 0,
    what: 'Off by default (opt-in via the Auto-Trade config). This symbol’s own % price change over a lookback window (20 trading days by default) minus a benchmark’s (SPY by default) over the same window — outperformance scores higher for longs, underperformance scores higher for shorts.',
  },
  {
    name: 'Sentiment',
    weight: 0,
    what: 'Off by default (opt-in via the Auto-Trade config). Counts how many of a small, fixed list of finance-specific positive/negative words or phrases ("beats estimates", "downgraded", "lawsuit", …) appear across the symbol’s recent headlines — net positive hits minus negative. A simple keyword count, not a third-party sentiment API or ML model, so every hit stays traceable to the actual word list. Net-positive headlines score higher for longs, net-negative for shorts.',
  },
];

export default function AboutPage() {
  return (
    <div className="max-w-3xl mx-auto space-y-4">
      <PageHeader
        title="How this works"
        subtitle="A transparent, rule-based research assistant — every number on screen traces back to a formula here. It is not a signal service and it never places trades."
      />

      <Section id="whatThisIs" title="What this is (and isn’t)">
        <p>
          This is a personal <strong className="text-slate-200">decision-support and tracking</strong> tool. It screens
          a universe you control, scores symbols with a configurable rule set, helps you reason about option entries and
          exits, and journals your trades so you can review your own results.
        </p>
        <p>
          It is <strong className="text-slate-200">not</strong> a predictor and makes no claim of accuracy. There is no
          machine-learning black box and no “buy” calls — just heuristics you can inspect, re-weight, and disagree with.
          Every decision is yours.
        </p>
      </Section>

      <Section id="screenerScore" title="How the screener score works">
        <p>
          Each symbol gets seven sub-scores, each normalized to <span className="tabular-nums">0–100</span>. The total
          is their <strong className="text-slate-200">weighted average</strong> using the weights below (also 0–100).
          Every result ships with its full breakdown — raw value, sub-score, weight, and contribution — so nothing is
          hidden. All weights, periods, and scales are editable in the screener config.
        </p>
        <p className="mt-2">
          When auto-trading acts on a candidate, that total score is also bucketed into a{' '}
          <strong className="text-slate-200">conviction grade</strong> stamped on the position — <strong>A</strong> at
          or above the configured A threshold (75 by default), <strong>B</strong> at or above the B threshold (60), else{' '}
          <strong>C</strong>. The grade is metadata, not a filter: it doesn’t change which trades are taken, but it lets
          the Journal report realized edge <em>per conviction tier</em>. An opt-in{' '}
          <strong className="text-slate-200">expectancy-weighted sizing</strong> setting (off by default) then acts on
          that edge: each grade’s position size is scaled by its own realized average R —{' '}
          <span className="tabular-nums">multiplier = 1 + avg&nbsp;R</span>, clamped to a min/max bound you choose (e.g.{' '}
          <span className="tabular-nums">0.5×–1.5×</span>), so a grade that has proven positive expectancy risks more
          and one that bleeds risks less, while a grade with too few closed trades stays neutral at{' '}
          <span className="tabular-nums">1×</span>. It multiplies with the other sizing factors (step-down, regime,
          equity-curve) and never lifts total exposure past the aggregate-risk cap; paper and live are scored on
          separate books.
        </p>
        <div className="mt-2 overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-[11px] uppercase tracking-wide text-slate-500 border-b border-ink-600/60">
                <th className="py-1.5 pr-3 font-medium">Component</th>
                <th className="py-1.5 pr-3 font-medium tabular-nums">Default weight</th>
                <th className="py-1.5 font-medium">What it measures</th>
              </tr>
            </thead>
            <tbody>
              {COMPONENTS.map((c) => (
                <tr key={c.name} className="border-b border-ink-700/50 align-top">
                  <td className="py-2 pr-3 font-medium text-slate-200 whitespace-nowrap">{c.name}</td>
                  <td className="py-2 pr-3 tabular-nums text-slate-300">{c.weight}</td>
                  <td className="py-2 text-slate-400">{c.what}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="text-xs text-slate-500">
          Filters (price, average volume, RSI band, trend alignment — daily and weekly) are applied separately — a
          symbol can score well yet be flagged as not passing your filters, with the reasons shown.
        </p>
        <p className="mt-2">
          <strong className="text-slate-200">Regime-adaptive weights</strong> (auto-trade config, off by default) let
          the six core weights above change with the market. When on, the loop reads the{' '}
          <strong className="text-slate-200">market-regime</strong> label (see below) at scoring time and swaps in that
          regime’s weight preset — <span className="tabular-nums">risk-on</span>,{' '}
          <span className="tabular-nums">neutral</span>, or <span className="tabular-nums">risk-off</span> — so the
          screener can, say, reward trend more when risk is on and RSI/mean-reversion more when it’s off. The presets
          default to the standard weights (so enabling changes nothing until you edit one), and{' '}
          <em>relative strength</em> and <em>sentiment</em> always keep their own separate weights regardless. Off, the
          weights are the fixed defaults shown above. It applies in live, paper, and{' '}
          <strong className="text-slate-200">backtests</strong> — a backtest derives each historical day’s regime from
          the benchmark series it already loads (proxy trend + volatility only; breadth is omitted), so a differentiated
          preset can be measured before it’s trusted live.
        </p>
      </Section>

      <Section id="alerts" title="Alerts & the suggested exit">
        <p>
          An alert is a one-shot <strong className="text-slate-200">condition</strong> you set — never a buy/sell call.
          Each evaluation reads the current value and trips when it crosses your threshold (
          <span className="tabular-nums">above</span> / <span className="tabular-nums">below</span>).
        </p>
        <ul className="list-disc pl-5 space-y-1.5 text-slate-400 mt-2">
          <li>
            <strong className="text-slate-200">Stock metrics:</strong> price, change&nbsp;%, relative volume, RSI,
            MA20−MA50 spread (a level-based MA-cross proxy), and % from the 52-week high / low.
          </li>
          <li>
            <strong className="text-slate-200">Option-contract metrics</strong> (a specific call/put): the underlying
            price, the contract’s <strong className="text-slate-200">mark</strong> ((bid+ask)/2),{' '}
            <strong className="text-slate-200">bid</strong>, <strong className="text-slate-200">ask</strong>,{' '}
            <strong className="text-slate-200">|Δ|</strong> (absolute delta, 0–1), and{' '}
            <strong className="text-slate-200">IV&nbsp;%</strong> (implied volatility × 100). These read from the option
            chain, so they need an options-capable provider; the underlying-price trigger works with any provider.
          </li>
          <li>
            <strong className="text-slate-200">Suggested exit (entry alerts):</strong> an entry alert auto-attaches a
            one-line exit from your exit-rules config — by default{' '}
            <strong className="text-slate-200">take-profit +50%</strong>,{' '}
            <strong className="text-slate-200">stop −50%</strong>, and{' '}
            <strong className="text-slate-200">time-exit 7 days before expiry</strong> (plus a delta band if you set
            one). Editing your option exit rules changes what gets suggested.
          </li>
        </ul>
      </Section>

      <Section id="marketRegime" title="How the market-regime gauge works">
        <p>
          The Today dashboard’s <strong className="text-slate-200">Market regime</strong> tile folds four independent,
          backward-looking signals into one <strong className="text-slate-200">Risk-on / Neutral / Risk-off</strong>{' '}
          read. It’s context for you — it does <strong className="text-slate-200">not</strong> place, size, or block any
          trade.
        </p>
        <p className="mt-2">Each signal contributes +1 (risk-on), −1 (risk-off), or 0 (neutral):</p>
        <ul className="list-disc pl-5 space-y-1.5 text-slate-400 mt-2">
          <li>
            <strong className="text-slate-200">Primary trend (200-day):</strong> the proxy (SPY) vs its own 200-day
            average. More than <span className="tabular-nums">+1%</span> above → risk-on; more than{' '}
            <span className="tabular-nums">1%</span> below → risk-off; inside that band → neutral.
          </li>
          <li>
            <strong className="text-slate-200">Intermediate trend (50-day):</strong> the same ±1% test against the
            proxy’s 50-day average.
          </li>
          <li>
            <strong className="text-slate-200">Breadth:</strong> the share of your universe (up to 120 names) trading
            above <em>its own</em> 50-day average. <span className="tabular-nums">≥ 55%</span> → risk-on;{' '}
            <span className="tabular-nums">≤ 45%</span> → risk-off; between → neutral.
          </li>
          <li>
            <strong className="text-slate-200">Volatility:</strong> the proxy’s ATR as a % of price. Below{' '}
            <span className="tabular-nums">2%</span> (calm) → risk-on; above <span className="tabular-nums">4%</span>{' '}
            (stressed) → risk-off; between → neutral.
          </li>
        </ul>
        <p className="mt-2">
          The four points are summed: <span className="tabular-nums">+2 or more</span> reads{' '}
          <strong className="text-slate-200">Risk-on</strong>, <span className="tabular-nums">−2 or less</span> reads{' '}
          <strong className="text-slate-200">Risk-off</strong>, and anything in between stays{' '}
          <strong className="text-slate-200">Neutral</strong> — a 2-point margin, not a bare majority, is needed to
          leave neutral. A signal whose data can’t be fetched reads{' '}
          <strong className="text-slate-200">“no data”</strong> and is dropped from the sum entirely, never counted as a
          fake neutral in any regime’s favor. The read is cached for an hour, since it turns on the daily close.
        </p>
      </Section>

      <Section id="sectorRotation" title="How the sector-rotation board works">
        <p>
          The Screener’s <strong className="text-slate-200">Sector rotation</strong> panel ranks your universe’s sectors
          by the <strong className="text-slate-200">median relative strength</strong> of their members over a 20-day
          lookback. A member’s relative strength is its own lookback return minus the benchmark’s (
          <strong className="text-slate-200">SPY</strong>) over the same window — the same idea as the screener’s{' '}
          <em>Rel. Strength</em> component above. Taking the <strong className="text-slate-200">median</strong> (not the
          mean) across a sector keeps one runaway member from carrying the whole group.
        </p>
        <p className="mt-2">
          Sectors sort strongest → weakest. If SPY’s own history can’t be fetched, the board degrades to ranking by{' '}
          <strong className="text-slate-200">absolute return</strong> and labels itself as such; a member whose history
          can’t be fetched is dropped from its sector’s sample (never a fake 0), and a sector with no resolvable members
          is listed rather than ranked. It’s a read-only ranking and a navigation aid — clicking a sector scans just its
          members — and it does <strong className="text-slate-200">not</strong> add any bonus to a symbol’s screener
          score. Cached hourly.
        </p>
      </Section>

      <Section id="glossary" title="Glossary">
        <dl>
          <Term term="Moving average">
            Average closing price over the last N periods (e.g. 20MA, 50MA). Used to gauge trend and how stretched price
            is.
          </Term>
          <Term term="RSI">
            Relative Strength Index (0–100) — momentum oscillator from average gains vs losses over a period (default
            14).
          </Term>
          <Term term="ATR / ATR%">
            Average True Range — typical daily price range. Shown as a % of price so volatility is comparable across
            symbols.
          </Term>
          <Term term="Rel. volume">
            Today’s volume relative to its recent average; &gt;1× means heavier-than-usual trading.
          </Term>
          <Term term="Beta">
            A symbol’s historical sensitivity to the broad market, from your data provider — 1.0 moves with the market,
            &gt;1 amplifies it, &lt;1 dampens it. Positions → Market stress test uses it to estimate P&L for a
            hypothetical market move.
          </Term>
          <Term term="Gap">Overnight move from the prior close to today’s open, as a %.</Term>
          <Term term="Delta">
            Option Greek: ≈ how much the option price moves per $1 move in the underlying; also a rough proxy for the
            probability of finishing in-the-money.
          </Term>
          <Term term="Greeks">
            Delta, gamma, theta, vega — sensitivities of an option’s price to spot, time, and volatility.
          </Term>
          <Term term="IV / IV rank">
            Implied volatility (the market’s expected movement priced into options) and where today’s IV sits within its
            own recent range (0–100%).
          </Term>
          <Term term="POP">
            Probability of profit — a lognormal estimate of finishing past breakeven, given your inputs. An estimate,
            not a guarantee.
          </Term>
          <Term term="Expected value (options)">
            The same lognormal model’s probability-weighted average P&amp;L at expiration, in dollars (Strategy Builder,
            Roll analyzer). A structure with a lower POP can still have a higher EV if its payoff is more favorably
            skewed — POP alone can’t show that.
          </Term>
          <Term term="Expectancy">Average profit/loss per trade = (win rate × avg win) − (loss rate × avg loss).</Term>
          <Term term="Profit factor">Gross profit ÷ gross loss. Above 1 means winners outweigh losers.</Term>
          <Term term="SQN">
            System Quality Number (Van Tharp): mean R ÷ the standard deviation of R, × √N (N capped at 100). Rewards a
            strong, consistent edge across many trades — roughly: ~2 average, 3+ excellent.
          </Term>
        </dl>
      </Section>

      <Section id="dataAssumptions" title="Data & assumptions">
        <ul className="list-disc pl-5 space-y-1.5 text-slate-400">
          <li>
            Market data comes from the provider you configure. Quotes may be delayed (commonly ~15 minutes on free
            tiers). The provider chip in the header shows whether you’re on{' '}
            <strong className="text-slate-200">live</strong> or <strong className="text-slate-200">demo</strong> data.
          </li>
          <li>
            <strong className="text-slate-200">Demo / synthetic data</strong> is deterministic placeholder data for
            trying the app with no API key. It is clearly labeled and must not be used for real decisions.
          </li>
          <li>
            When a provider doesn’t return option Greeks, they’re computed with the{' '}
            <strong className="text-slate-200">Black–Scholes</strong> model. Those are estimates that assume European
            exercise, no dividends, and constant volatility — real options can differ.
          </li>
          <li>
            IV rank builds from implied volatility accrued over time; until enough history exists it falls back to a
            realized-volatility proxy, which is labeled as such.
          </li>
          <li>
            Responses are cached briefly and auto-polling is off by default to respect provider rate limits — use
            Refresh for the latest, and watch the “last updated” stamps.
          </li>
        </ul>
      </Section>

      <Section id="privacy" title="Privacy">
        <p>
          Your data stays with you. Positions, journal entries, presets, and settings live in a{' '}
          <strong className="text-slate-200">local SQLite database</strong> on the machine running the server. API keys
          are held <strong className="text-slate-200">server-side only</strong> and are never sent to the browser. The
          only outbound network calls are from the server to the market-data provider you chose.
        </p>
      </Section>

      <Section id="disclaimers" title="Disclaimers">
        <ul className="list-disc pl-5 space-y-1.5 text-slate-400">
          <li>
            This tool is for personal research and education. It is{' '}
            <strong className="text-slate-200">not financial, investment, or trading advice</strong>, and nothing here
            is a recommendation to buy or sell anything.
          </li>
          <li>No guarantee of accuracy, completeness, or performance. Past results never guarantee future outcomes.</li>
          <li>
            Trading stocks and options carries substantial risk of loss. You are solely responsible for your decisions.
          </li>
          <li>The app does not connect to a broker and does not place orders.</li>
        </ul>
      </Section>
    </div>
  );
}
