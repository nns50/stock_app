import { ReactNode } from 'react';
import { Card } from '../components/ui';

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <Card className="p-4 sm:p-5">
      <h2 className="text-base font-semibold text-slate-100">{title}</h2>
      <div className="mt-2 space-y-2 text-sm text-slate-300 leading-relaxed">{children}</div>
    </Card>
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

// The six scoring components, mirroring server/src/indicators/screener.ts so the
// page stays an accurate description of what the engine actually does.
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
];

export default function AboutPage() {
  return (
    <div className="max-w-3xl mx-auto space-y-4">
      <div>
        <h1 className="text-xl font-semibold">How this works</h1>
        <p className="text-sm text-slate-400 mt-1">
          A transparent, rule-based research assistant — every number on screen is something you can trace back to a
          formula here. It is not a signal service and it never places trades.
        </p>
      </div>

      <Section title="What this is (and isn’t)">
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

      <Section title="How the screener score works">
        <p>
          Each symbol gets six sub-scores, each normalized to <span className="tabular-nums">0–100</span>. The total is
          their <strong className="text-slate-200">weighted average</strong> using the weights below (also 0–100). Every
          result ships with its full breakdown — raw value, sub-score, weight, and contribution — so nothing is hidden.
          All weights, periods, and scales are editable in the screener config.
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
          Filters (price, average volume, RSI band, trend alignment) are applied separately — a symbol can score well
          yet be flagged as not passing your filters, with the reasons shown.
        </p>
      </Section>

      <Section title="Glossary">
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
          <Term term="Expectancy">Average profit/loss per trade = (win rate × avg win) − (loss rate × avg loss).</Term>
          <Term term="Profit factor">Gross profit ÷ gross loss. Above 1 means winners outweigh losers.</Term>
        </dl>
      </Section>

      <Section title="Data & assumptions">
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

      <Section title="Privacy">
        <p>
          Your data stays with you. Positions, journal entries, presets, and settings live in a{' '}
          <strong className="text-slate-200">local SQLite database</strong> on the machine running the server. API keys
          are held <strong className="text-slate-200">server-side only</strong> and are never sent to the browser. The
          only outbound network calls are from the server to the market-data provider you chose.
        </p>
      </Section>

      <Section title="Disclaimers">
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
