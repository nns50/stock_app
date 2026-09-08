# Market regime model — a Gaussian HMM over daily S&P 500 features

**Status:** the model, its trainer, its TypeScript port and the parity tests shipped first;
the **reading** now runs in the app (section 5a): `GET /api/market/regime-ml`, the "ML regime
(HMM)" block of the Today page's Market regime tile, the loop's once-per-tick read mirrored on
each tick summary and the Auto-Trade page's _Last cycle_ card, and the journal actions
`ml_regime_read`, `ml_regime_changed`, `ml_regime_drift`, `ml_regime_fetch_failed` and
`ml_regime_override`. Every position the loop opens — paper and live, stocks and options —
also carries the label as at-entry context (`ml_regime`, in the journal export as `mlRegime`;
null when the reading was unknown or stale). **Nothing sizes or gates on the reading yet** —
the sizing overlay and the target tighten are later, separately gated changes (see
`docs/AUTOTRADING_SPEC.md` as they land).

Decision-support only, not financial advice — the same framing as the About page. A regime
label is a description of the tape's volatility, not a prediction of where prices go.

← back to the [README](../README.md) · [User Guide](USER_GUIDE.md) ·
[Strategy Playbook](STRATEGY_PLAYBOOK.md)

---

## 1. What it is

A three-state **Gaussian hidden Markov model** (`hmmlearn.hmm.GaussianHMM`, full covariance)
fitted on standardized daily features of the S&P 500 and the VIX. Each state is named by a
written rule from its fitted means:

| label              | in the operator's words | what the state's fitted means say                 |
| ------------------ | ----------------------- | ------------------------------------------------- |
| `high_vol_bearish` | High Volatility/Bearish | highest VIX and realized vol, weakest drift       |
| `low_vol_bullish`  | Low Volatility/Bullish  | lowest VIX and realized vol, strongest drift      |
| `sideways`         | Sideways                | the state in between                              |

"Bearish" and "Bullish" describe the states' **fitted mean drift over the training window**.
They are **not** direction forecasts — section 6 shows that out of sample the sessions read
as High Volatility/Bearish were followed, on average, by _positive_ 20-day returns (the bounce
after stress). What the model is predictive of is **volatility**: which regime the next
sessions' realized vol will look like.

The utility the request asked for is `get_market_regime()` in `ml/regime/infer.py`
(`from ml.regime import get_market_regime`), also available as
`npm run regime:predict`. It returns the regime, its display label, the filtered
probability of every state, the one-step-ahead state distribution (`posterior × A`), the
data date the reading is "as of", the feature values it read, and a drift flag (section 5).

## 2. Data

Both series come from FRED's keyless CSV endpoint
(`https://fred.stlouisfed.org/graph/fredgraph.csv?id=<ID>&cosd=<start>`):

| series   | what                         | notes                                                             |
| -------- | ---------------------------- | ----------------------------------------------------------------- |
| `SP500`  | S&P 500 index daily close    | FRED serves only the most recent **ten years** of this series     |
| `VIXCLS` | CBOE VIX daily close         | full history                                                      |

Parsing rules (`ml/regime/data.py`, mirrored by the runtime fetcher when it lands): the header
must be exactly `observation_date,<ID>`; a `.` value is a holiday/missing print and is dropped;
dates are sorted and de-duplicated (last wins). Training and inference read the **same series
from the same endpoint**, so they see identical numbers by construction.

**Publication lag.** FRED posts the S&P 500 close the next business morning and the VIX close
often a day after that. The reading's `asOf` is the last date with **both** series — on
2026-09-07 that was 2026-09-03 (the S&P was through 09-04, the VIX through 09-03). A regime
reading therefore describes the tape as of one to two sessions ago; a shock day itself is
never in the data (section 7).

## 3. Features, in the one order every implementation shares

Computed on the S&P 500 series **alone** before the join with the VIX (a VIX holiday never
punches a hole in a return), then inner-joined on date, then rows with any non-finite value
dropped — which removes the first 20 S&P 500 rows.

| #   | name      | formula                                                                 |
| --- | --------- | ----------------------------------------------------------------------- |
| 1   | `ret`     | `ln(close_t / close_t−1)` — daily log return                             |
| 2   | `logVix`  | `ln(VIX close)`                                                          |
| 3   | `logRv20` | `ln( sample std (ddof 1) of the last 20 ret )` — realized vol, not annualized |

Why the **log** of the 20-day standard deviation: volatility is roughly log-normal. On the raw
scale the COVID crash (realized vol 4–5% a day) sits so far from a calm 0.7% that a Gaussian
state fitted through it becomes a crash-only state, and the 2022 bear market (1.2–1.6%) reads
as Sideways — 33% of that episode was High Vol in the first walk-forward run. On the log scale
the distances are proportional and the same check reads 67% (section 6). The runtime port
applies the identical transform.

Features are standardized with a `StandardScaler` (per-feature mean and scale, stored in the
artifact) before the HMM sees them.

## 4. Training

| field                  | value                                                     |
| ---------------------- | --------------------------------------------------------- |
| version                | `2026.09.1`                                               |
| training window        | 2021-09-07 → 2026-09-03 (the five years ending at training; 1254 sessions) |
| model                  | `GaussianHMM(n_components=3, covariance_type="full")`     |
| seed / max EM iter / tol | 7 / 500 / 1e-4 — converged in 128 iterations             |
| prior for inference    | the **stationary distribution** of the fitted transition matrix (the fit's own start probability only says which state the training sequence began in) |
| retrain by             | 2027-01-01 (`training.retrainBy`, 120 days after `trainedThrough`) |
| libraries              | hmmlearn 0.3.3 · scikit-learn 1.9.0 · numpy 2.4.6 · pandas 3.0.5 · Python 3.11 |

Fitted states, raw scale (from `ml/reports/regime-2026-09-03.md`; `mean ret` is the fitted
daily drift annualized for readability, `rv20` is `exp(mean logRv20)`):

| label              | mean ret (ann.) | VIX level | rv20 (daily) | expected dwell (sessions) | stationary share |
| ------------------ | --------------- | --------- | ------------ | ------------------------- | ---------------- |
| `high_vol_bearish` | −3.3%           | 25.2      | 1.46%        | 52.1                      | 0.276            |
| `low_vol_bullish`  | +22.4%          | 15.0      | 0.63%        | 35.8                      | 0.387            |
| `sideways`         | +12.1%          | 18.5      | 0.91%        | 21.0                      | 0.337            |

Transition matrix (from row → to column):

| from \ to          | `high_vol_bearish` | `low_vol_bullish` | `sideways` |
| ------------------ | ------------------ | ----------------- | ---------- |
| `high_vol_bearish` | 0.9808             | 0.0000            | 0.0192     |
| `low_vol_bullish`  | 0.0000             | 0.9721            | 0.0279     |
| `sideways`         | 0.0157             | 0.0320            | 0.9523     |

Note the zeros: the fit never saw the market go straight from Low Vol to High Vol or back —
it passes through Sideways. That is one reason a one-day shock cannot flip the reading in a
day (section 7).

### The labeling rule (asserted, never guessed)

`ml/regime/model.py` names the states from their fitted means and **raises `LabelingError`**
instead of exporting when the fit does not separate the way the labels claim:

1. order the three states by their `logVix` mean — highest is `high_vol_bearish`, lowest is
   `low_vol_bullish`, the middle one is `sideways`;
2. the highest-VIX state must also have the highest `logRv20` mean (the two volatility
   readings must agree about which state is stressed);
3. the high-vol state may not drift up faster than the low-vol state — "Bearish" and
   "Bullish" must not be lies.

The drifts of the two calm states are reported, not asserted: right after a crash a fit can
split them into "calm and rising" and "calmer and rising less", and an earlier version of the
rule that demanded the bullish state be the calmer one refused a valid 2020-04 refit.
A `LabelingError` means retrain with another seed; a state is never relabeled by hand.

## 5. Inference — what a reading is

`ml/regime/infer.py` is the reference and `server/src/services/hmmForward.ts` is its port;
`server/data/regimeModel.fixture.json` holds a window of real rows with every intermediate,
and `server/test/regimeModelParity.test.ts` holds the port to it (section 8).

1. Take the last **250** feature rows (`inferenceWindow`; fewer than 60 rows is refused).
2. Standardize with the artifact's scaler.
3. Run the **forward filter** from the stationary prior, in log space:
   `logAlpha[k] = ln π[k] + logB[0][k]`, then for each step
   `logPred[j] = logsumexp_i(ln post[t−1][i] + ln A[i][j])`, `logAlpha[j] = logPred[j] + logB[t][j]`,
   `ct = logsumexp(logAlpha)`, `post[t] = exp(logAlpha − ct)`. The posterior of the last row is
   the reading; `Σ ct` equals hmmlearn's `score()`. Filtering only — never Viterbi or
   forward–backward smoothing, which label a day with its own future.
4. **Sticky switch.** The reading keeps yesterday's regime unless the new argmax posterior is
   at least the switch threshold (**0.6** by default). No previous regime → accept the argmax.
   This is what makes the label a regime and not a daily coin flip; out of sample it held the
   previous regime on 0.6% of sessions.
5. **Predicted next** = `post × A`, the one-step-ahead state distribution.
6. **Drift.** The trailing-10-session mean of `ct` (each `ct` is `ln p(x_t | past)`) is
   compared with the training set's 5th percentile of the same statistic (`drift.p5`, −4.71
   for this model). Below it, the reading carries `drift: true`. **Drift is a retrain
   signal, not a gate.** The first walk-forward run had it turn the regime `unknown`, and the
   flag fired on 92% of COVID-crash sessions — an overlay that fails open on drift would have
   switched itself off in the one episode it exists for. An observation far from every state
   in the high-vol direction is still nearest the high-vol state, so the label under drift is
   directionally right; what drift means is "the probabilities are no longer calibrated —
   retrain".

## 5a. At runtime — how the app reads it

`server/src/services/mlRegime.ts` produces one reading per ET day:

- **Source.** `ML_REGIME_SOURCE=fred` (default) fetches the same two FRED series the model was
  trained on and caches every close in the `daily_series` table (FRED rows only). If FRED
  fails, the cached rows are used while they are fresh; then the configured market-data
  provider's `^GSPC`/`^VIX` daily candles (`source: provider`, never persisted, never the
  mock provider). `provider` skips FRED; `off` skips every fetch and reads `unknown` — the
  test suite runs that way.
- **Refresh.** The loop reads once per tick, in or out of session. A day's first tick is just
  after midnight ET, before FRED has posted the prior close, so the service refetches at most
  hourly until both series carry the previous session's close and then holds for the day. A
  reading can therefore update once mid-morning; the sticky switch keeps that from flapping.
- **Persistence.** Every reading (including `unknown`) is stored in `ml_regime_readings`,
  keyed by ET day, with the label — never a state index, so a retrain cannot corrupt the
  sticky switch's "previous regime", which is the newest **known** day before today.
- **Journal.** `ml_regime_read` once per day on the first known reading (regime, probabilities,
  data date, source, drift, previous), `ml_regime_changed` when the sticky switch changes the
  regime, `ml_regime_drift` once per day while drift is raised, `ml_regime_fetch_failed` once
  per day, and `ml_regime_override` when `ML_REGIME_DEV_OVERRIDE` forces a label (refused in
  production).
- **Display.** `GET /api/market/regime-ml` (`?force=true` refetches now), the Market regime
  tile's ML block, the tick summary's `mlRegime` mirror and the dashboard's `mlRegime` (a
  peek at today's reading — never a fetch).
- **Freshness.** `server/test/regimeModelFreshness.test.ts` fails once today passes the
  artifact's `retrainBy`; the fix is section 10, never deleting the test.

## 6. Validation — walk-forward, out of sample

`python -m ml.regime.evaluate` refits a fresh model **every quarter** on the trailing (up to)
five years — the first refits on three to five years, since FRED serves ten years of the S&P
500 — re-labels its states by the same rule, and classifies every session of that quarter
exactly as the runtime would: a 250-row window ending on that session, filtered from the
stationary prior, sticky-switched from the previous session. No session's reading has seen
that session's future. Full tables: `ml/reports/regime-eval-2026-09-07.md`.

Coverage: **1741 OOS sessions, 2019-10-01 → 2026-09-03, 28 refits, all converged, no
`LabelingError`.**

Sticky path (what the runtime reads), forward statistics per regime (daily log returns,
2,000-draw bootstrap 95% CIs):

| regime             | sessions | next-20d mean log return | next-20d realized vol (daily) | share above the unconditional median vol |
| ------------------ | -------- | ------------------------ | ----------------------------- | ---------------------------------------- |
| `high_vol_bearish` | 462      | +2.73% [2.18, 3.31]      | **1.51% [1.43, 1.60]**        | 87%                                      |
| `low_vol_bullish`  | 616      | +1.36% [1.12, 1.60]      | **0.75% [0.73, 0.76]**        | 37%                                      |
| `sideways`         | 663      | −0.26% [−0.69, 0.15]     | 1.00% [0.95, 1.05]            | 59%                                      |

**The gate, written before the run:** the size cut is justified by volatility persistence, so
the model must separate next-20-day realized vol in High Vol from Low Vol with
non-overlapping intervals. **It does** — 1.51% [1.43, 1.60] against 0.75% [0.73, 0.76], with
Sideways in between on both paths. Forward returns were reported but were never the gate,
and they show what "Bearish" is: the sessions read as High Vol had the _highest_ average
forward return (the post-stress bounce). Anyone using this reading as a direction call has
the sign wrong.

Transitions on the sticky path: **7.5 switches per year**, mean dwell 32.8 sessions, 0.6% of
sessions held below the threshold, drift flag on 9.2% of sessions (the rule allows up to ~10
switches a year).

Known-episode check (the rule for each was written before the run):

| episode               | window / date           | result                     | rule              | verdict |
| --------------------- | ----------------------- | -------------------------- | ----------------- | ------- |
| COVID crash           | 2020-02-24 → 2020-04-30 | 100% High Vol              | ≥ 50%             | pass    |
| 2022 bear market      | 2022-01-03 → 2022-10-12 | 66.8% High Vol             | ≥ 50%             | pass    |
| Aug-2024 vol spike    | 2024-08-05              | not reached (read Sideways) | within 2 sessions | **fail** |
| Apr-2025 tariff shock | 2025-04-08              | High Vol on 2025-04-08     | within 2 sessions | pass    |

The Aug-2024 miss is the documented limit of these features: a spike shorter than the 20-day
realized-vol window (VIX 38 → 23 within three sessions) is read as Sideways by a daily-close
model. A grind (2022) or a crash (2020) that outlasts the window reads High Vol. The case a
daily model cannot see — day one of a shock — is what the intraday range nowcast trigger is
for when the overlay lands; until then this row stays in the report as the standing reminder.

Drift inside the episodes: 94% of COVID-crash sessions (as it must — the tape left every calm
model's distribution) and 5% of 2022 sessions.

## 7. What it does NOT do

- **It is not a direction forecast.** "Bearish" is fitted drift over the training window;
  section 6 shows positive forward returns after High Vol readings out of sample.
- **It cannot see today.** FRED's lag puts the reading one to two sessions behind, and a
  one-day shock is not in the data until the next morning. Day one of a spike is missed.
- **It cannot see intraday.** The features are daily closes; a spike shorter than 20 sessions
  is smoothed away (Aug-2024).
- **It is not a trading signal.** It does not know the book, the strategy, or the symbol. Any
  use in sizing or targets is a separate, gated change with its own evidence.
- **It has three states because the request asked for three.** Volatility is a continuum;
  the boundaries are where the fit put them, and a retrain moves them.
- **It has only seen 2016–2026.** Ten years of S&P 500 closes, one crash, one grind. A regime
  that looks like neither is exactly when the drift flag says "retrain".

## 8. Parity — two implementations, one algorithm

- `ml/regime/infer.py` is pure numpy and imports neither hmmlearn nor scikit-learn.
- `train.py` refuses to write the fixture unless its own filter reproduces hmmlearn on the
  fixture window: `|loglik − score()| < 1e-9` and `filtered[−1] ≈ predict_proba()[−1]` to
  1e-9 — `predict_proba` is forward–backward **smoothed**, so only its last row is a filtered
  value and only that row is compared. On this model the two agree to ~1e-13.
- `server/data/regimeModel.fixture.json` carries the last 40 feature rows of the training
  set, the 61 raw closes they need, the standardized rows, every filtered posterior, the
  per-step and total log-likelihood, `predict_proba()[−1]`, the predicted-next vector and
  the drift score.
- `server/test/regimeModelParity.test.ts` rebuilds the features from the raw closes, then
  checks every intermediate against the fixture to 1e-9 (the log-likelihoods to 1e-6 against
  hmmlearn's own number). `server/test/hmmForward.test.ts` checks the filter against a
  hand-worked two-state example and the feature builder against numpy's definitions.
- `ml/tests` (pytest, developer machine only) checks the labeling rule including its
  refusals, the export round trip (`precision · covariance ≈ I`), the sticky rule's five
  cases, drift, and `forward_filter` against hmmlearn on a synthetic fit.

## 9. The artifact

`server/data/regimeModel.json` is copied into the image with the rest of `server/data` and
validated with zod on load (`server/src/services/regimeModel.ts`): three distinct labels,
stochastic rows, symmetric precisions, positive scales. A missing or corrupt file loads as
`null` with one console warning — the app never throws on it. It carries, precomputed so the
runtime does no linear algebra: the scaler, `startprob` (stationary), `transmat`, and per
state its mean, **precision** (`inv(Σ)`), **logDet** (`ln|Σ|`), covariance (for humans), raw
means and expected dwell; plus `inferenceWindow`, `switchThresholdDefault`, the `training`
provenance block (window, seed, iterations, convergence, log-likelihood, data sha256, library
versions, `retrainBy`) and the `drift` block (`window`, `p5`, `median`).

`server/data/regimeHistory.json` is the walk-forward out-of-sample path of section 6, keyed
by **data date** — for the backtest, which shifts it one session (the morning FRED publishes).

## 10. Retraining

Quarterly, or when the drift flag persists. The runtime needs no Python; retraining does:

```bash
python3 -m venv ml/.venv && . ml/.venv/bin/activate
pip install -r ml/requirements.txt
python -m pytest ml/tests -q
npm run regime:train    -- --version 2026.12.1          # writes the artifact, the fixture, ml/reports/regime-<date>.md
npm run regime:evaluate -- --version 2026.12.1          # walk-forward path → server/data/regimeHistory.json + ml/reports/regime-eval-<date>.md
npm run regime:predict                                  # today's reading, to compare with the app
npm test -w server -- regimeModelParity                 # the TypeScript port agrees with what was just written
```

Bump `--version` (`YYYY.MM.n`), read the two reports against the rules in section 6, commit
the artifact, the fixture, the history and the reports together, and record the retrain in
`docs/AUTOTRADING_SPEC.md`'s decision log. A retrain that fails the gate or the labeling rule
is not shipped; the previous artifact stays.

## 11. Files

| path                                        | role                                                     |
| ------------------------------------------- | -------------------------------------------------------- |
| `ml/regime/data.py`                         | FRED fetch, parse, cache (`ml/data/cache/`, gitignored)  |
| `ml/regime/features.py`                     | the three features, in order                             |
| `ml/regime/model.py`                        | fit, labeling rule, export                               |
| `ml/regime/infer.py`                        | the numpy reference filter and `get_market_regime()`     |
| `ml/regime/train.py` / `evaluate.py` / `predict.py` | the three `npm run regime:*` scripts             |
| `ml/regime/report.py`                       | markdown tables and bootstrap CIs                        |
| `ml/tests/`                                 | pytest suite                                             |
| `ml/reports/`                               | the training and evaluation reports (committed evidence) |
| `server/data/regimeModel.json`              | the artifact                                             |
| `server/data/regimeModel.fixture.json`      | the parity fixture                                       |
| `server/data/regimeHistory.json`            | the walk-forward out-of-sample path                      |
| `server/src/services/hmmForward.ts`         | the TypeScript filter and feature builder                |
| `server/src/services/regimeModel.ts`        | artifact loading and validation                          |
| `server/test/hmmForward.test.ts`, `server/test/regimeModelParity.test.ts` | the tests            |
