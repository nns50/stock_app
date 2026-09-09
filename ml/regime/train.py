"""Train the regime HMM; export the artifact, the parity fixture and the report.

    python -m ml.regime.train --version 2026.09.1 [--end YYYY-MM-DD] [--years 5]
                              [--seed 7] [--n-iter 500] [--tol 1e-4]
                              [--out server/data] [--fixture-window 40]

Writes ``server/data/regimeModel.json`` (everything inference needs, precomputed),
``server/data/regimeModel.fixture.json`` (a window of real rows with every
intermediate the TypeScript port must reproduce) and
``ml/reports/regime-<trainedThrough>.md`` (the training half of the evidence;
``evaluate.py`` writes the walk-forward half).

It REFUSES to write the fixture unless its own numpy filter agrees with
hmmlearn on that window: ``|loglik - model.score| < 1e-9`` and
``allclose(filtered[-1], model.predict_proba[-1], 1e-9)``. Any disagreement
means the reference implementation is wrong, and shipping a fixture from a
wrong reference would make the TypeScript parity test prove the wrong thing.
"""

from __future__ import annotations

import argparse
import datetime as dt
import json
import platform
from pathlib import Path

import hmmlearn
import numpy as np
import pandas as pd
import sklearn

from .data import data_sha256, load_series
from .features import FEATURES, RV_WINDOW, build_features
from .infer import DRIFT_WINDOW, LABELS, drift_score, forward_filter, from_export, predicted_next, standardize
from .model import LabelingError, fit_hmm, label_states, raw_means, stationary_distribution, to_export
from .report import fmt, md_table

REPO_ROOT = Path(__file__).resolve().parents[2]
DEFAULT_OUT = REPO_ROOT / "server" / "data"
DEFAULT_REPORT_DIR = REPO_ROOT / "ml" / "reports"
RETRAIN_AFTER_DAYS = 120
# Calendar days fetched before the training start so the 20-row warmup lands
# before it and the first feature row is on (or just after) the start date.
WARMUP_CALENDAR_DAYS = 45
PARITY_ATOL = 1e-9
ANNUALIZE = 252


def parse_args(argv: list[str] | None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Train the market-regime HMM and export it.")
    parser.add_argument("--version", required=True, help="artifact version, e.g. 2026.09.1")
    parser.add_argument("--end", default=None, help="last data date (YYYY-MM-DD); default: today")
    parser.add_argument("--years", type=int, default=5, help="training window in years ending at --end")
    parser.add_argument("--seed", type=int, default=7)
    parser.add_argument("--n-iter", type=int, default=500)
    parser.add_argument("--tol", type=float, default=1e-4)
    parser.add_argument("--out", default=str(DEFAULT_OUT), help="directory for regimeModel.json + fixture")
    parser.add_argument("--fixture-window", type=int, default=40)
    parser.add_argument("--report-dir", default=str(DEFAULT_REPORT_DIR))
    parser.add_argument("--max-age-hours", type=float, default=12.0, help="FRED cache freshness")
    return parser.parse_args(argv)


def prepare_model(feats: pd.DataFrame, *, seed: int, n_iter: int, tol: float, version: str):
    """Fit, label, replace the prior with the stationary distribution, measure drift.

    Returns (model, scaler, labels, export_without_training, drift, ct_all).
    Shared with evaluate.py so every refit is prepared exactly like the shipped
    model. The fitted start probability says which state the TRAINING SEQUENCE
    began in -- meaningless for a rolling inference window -- so the export
    carries the stationary distribution of the fitted transition matrix, and
    the model object is given the same prior so hmmlearn's own score() and
    predict_proba() remain the parity reference.
    """
    x_raw = feats[list(FEATURES)].to_numpy(dtype=float)
    model, scaler = fit_hmm(x_raw, seed=seed, n_iter=n_iter, tol=tol)
    labels = label_states(model, scaler)
    stationary = np.clip(stationary_distribution(model.transmat_), 0.0, None)
    model.startprob_ = stationary / stationary.sum()
    provisional = to_export(model, scaler, labels, version=version, training={}, drift={"window": DRIFT_WINDOW})
    params = from_export(provisional)
    x_std = standardize(x_raw, params)
    _, loglik_all, ct_all = forward_filter(params, x_std)
    trailing = pd.Series(ct_all).rolling(DRIFT_WINDOW).mean().dropna().to_numpy()
    drift = {
        "window": DRIFT_WINDOW,
        "p5": float(np.percentile(trailing, 5)),
        "p1": float(np.percentile(trailing, 1)),
        "median": float(np.median(trailing)),
        "min": float(trailing.min()),
        "note": "trailing-window mean of the filtered per-step log-likelihood over the training set; "
        "a live reading below p5 is flagged as drift and the overlay fails open",
    }
    return model, scaler, labels, provisional, drift, ct_all, loglik_all


def build_fixture(
    model, params, feats: pd.DataFrame, sp500: pd.Series, vix: pd.Series, window: int, version: str
) -> dict:
    win = feats.iloc[-window:]
    x_win = win[list(FEATURES)].to_numpy(dtype=float)
    x_std = standardize(x_win, params)
    post, loglik, ct = forward_filter(params, x_std)
    score = float(model.score(x_std))
    pp_last = np.asarray(model.predict_proba(x_std)[-1], dtype=float)
    if abs(loglik - score) >= PARITY_ATOL:
        raise SystemExit(f"parity failure: numpy loglik {loglik!r} vs hmmlearn score {score!r}")
    if not np.allclose(post[-1], pp_last, atol=PARITY_ATOL):
        raise SystemExit(f"parity failure: filtered[-1] {post[-1]!r} vs predict_proba[-1] {pp_last!r}")
    first_date = win.index[0]
    p0 = int(sp500.index.get_loc(first_date))
    if p0 < RV_WINDOW:
        raise SystemExit("fixture window starts too early in the series for the rolling warmup")
    sp_slice = sp500.iloc[p0 - RV_WINDOW :]
    vix_slice = vix[vix.index >= sp_slice.index[0]]
    series_rows = lambda s: [{"date": d.date().isoformat(), "value": float(v)} for d, v in s.items()]  # noqa: E731
    return {
        "modelVersion": version,
        "window": int(window),
        "note": "Real FRED rows. buildFeatures(sp500, vix) must reproduce `features` exactly; standardize with "
        "the model's scaler; forwardFilter from the model's startprob over these rows must reproduce "
        "`filteredPosteriors`, `stepLogLik` and `logLikelihood` (which equals hmmlearn's score on the "
        "same window); `hmmlearnPredictProbaLast` is predict_proba()[-1] -- forward-backward smoothed, "
        "so only its LAST row is a filtered value.",
        "sp500": series_rows(sp_slice),
        "vix": series_rows(vix_slice),
        "features": [
            {"date": d.date().isoformat(), **{name: float(row[name]) for name in FEATURES}} for d, row in win.iterrows()
        ],
        "standardized": x_std.tolist(),
        "filteredPosteriors": post.tolist(),
        "stepLogLik": ct.tolist(),
        "logLikelihood": float(loglik),
        "hmmlearnScore": score,
        "hmmlearnPredictProbaLast": pp_last.tolist(),
        "predictedNext": predicted_next(post[-1], params.transmat).tolist(),
        "driftScore": drift_score(ct, params.drift_window),
        "labels": list(params.labels),
    }


def annualized_pct(daily_log_return: float) -> float:
    return 100.0 * (float(np.exp(daily_log_return * ANNUALIZE)) - 1.0)


def write_report(path: Path, export: dict, model, scaler, feats: pd.DataFrame, labels: dict[int, str], ct_all):
    training = export["training"]
    raw = raw_means(model, scaler)
    order = sorted(range(model.n_components), key=lambda k: LABELS.index(labels[k]))
    idx = {name: FEATURES.index(name) for name in FEATURES}
    state_rows = []
    for k in order:
        state_rows.append(
            [
                labels[k],
                k,
                fmt(annualized_pct(raw[k, idx["ret"]]), 1) + "%",
                fmt(float(np.exp(raw[k, idx["logVix"]])), 1),
                fmt(100 * float(np.exp(raw[k, idx["logRv20"]])), 2) + "%",
                fmt(export["states"][k]["expectedDwellSessions"], 1),
                fmt(export["stationary"][k], 3),
            ]
        )
    trans_rows = [
        [labels[i]] + [fmt(export["transmat"][i][j], 4) for j in order] for i in order
    ]
    # In-sample occupancy from the filtered path's argmax.
    provisional = from_export(export)
    x_std = standardize(feats[list(FEATURES)].to_numpy(dtype=float), provisional)
    post, _, _ = forward_filter(provisional, x_std)
    argmax = post.argmax(axis=1)
    occ_rows = []
    for k in order:
        mask = argmax == k
        n = int(mask.sum())
        occ_rows.append([labels[k], n, fmt(100 * n / len(argmax), 1) + "%"])
    trailing = pd.Series(ct_all).rolling(export["drift"]["window"]).mean().dropna()
    lines = [
        f"# Regime model {export['version']} — training report",
        "",
        "Generated by `python -m ml.regime.train`. The walk-forward, out-of-sample half of the",
        "evidence is in the matching `regime-eval-*.md` written by `python -m ml.regime.evaluate`.",
        "",
        "## Provenance",
        "",
        md_table(
            ["field", "value"],
            [
                ["version", export["version"]],
                ["training window", f"{training['trainingStart']} → {training['trainedThrough']} ({training['nObs']} sessions)"],
                ["retrain by", training["retrainBy"]],
                ["data sha256", training["dataSha256"]],
                ["seed / max iterations / tol", f"{training['seed']} / {training['nIter']} / {training['tol']}"],
                ["converged (iterations)", f"{training['converged']} ({training['iterations']})"],
                ["log-likelihood (hmmlearn score)", fmt(training["logLikelihood"], 4)],
                ["hmmlearn / scikit-learn / numpy", f"{training['hmmlearnVersion']} / {training['sklearnVersion']} / {training['numpyVersion']}"],
                ["python", training["pythonVersion"]],
                ["trained at", training["trainedAt"]],
            ],
        ),
        "",
        "## Fitted states (raw scale)",
        "",
        "`mean ret` is the state's fitted mean daily log return, annualized for readability — it is a",
        "description of the state's drift in the training window, **not a forecast**. `rv20` is",
        "exp(mean logRv20), the state's typical 20-day daily vol. The prior the runtime filters from is",
        "the stationary distribution of the fitted transition matrix.",
        "",
        md_table(
            ["label", "state", "mean ret (ann.)", "VIX level", "rv20 (daily)", "expected dwell (sessions)", "stationary"],
            state_rows,
        ),
        "",
        "## Transition matrix (from row → to column)",
        "",
        md_table(["from \\ to"] + [labels[k] for k in order], trans_rows),
        "",
        "## In-sample occupancy (filtered argmax)",
        "",
        md_table(["label", "sessions", "share"], occ_rows),
        "",
        "## Labeling assertions",
        "",
        "All passed: states are ordered by their fitted VIX mean (highest = High Vol, lowest = Low Vol,",
        "middle = Sideways); the highest-VIX state also has the highest rv20 mean; and the high-vol state",
        "does not drift up faster than the low-vol state. The two calm states' drifts are reported above,",
        "not asserted. A fit that fails any of these raises `LabelingError` and is not exported.",
        "",
        "## Drift statistic",
        "",
        f"Trailing-{export['drift']['window']}-session mean of the filtered per-step log-likelihood over the training set:",
        "",
        md_table(
            ["statistic", "value"],
            [
                ["median", fmt(float(trailing.median()), 4)],
                ["p5 (the drift line)", fmt(export["drift"]["p5"], 4)],
                ["p1", fmt(export["drift"]["p1"], 4)],
                ["min", fmt(export["drift"]["min"], 4)],
            ],
        ),
        "",
        "A live reading whose trailing mean falls below p5 is flagged `drift`: the overlay fails open",
        "(no cut, no tighten, no bar) and the gauge asks for a retrain.",
        "",
        "## Parity",
        "",
        "The numpy forward filter in `ml/regime/infer.py` reproduced hmmlearn's `score()` on the full",
        "training sequence and, on the fixture window, both `score()` and `predict_proba()[-1]` to",
        f"{PARITY_ATOL:g}. `server/test/regimeModelParity.test.ts` holds the TypeScript port to the same fixture.",
        "",
    ]
    path.write_text("\n".join(lines))


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)
    end = pd.Timestamp(args.end) if args.end else pd.Timestamp.today().normalize()
    start = end - pd.DateOffset(years=args.years)
    fetch_start = (start - pd.Timedelta(days=WARMUP_CALENDAR_DAYS)).date().isoformat()
    sp500, vix = load_series(fetch_start, end=end.date().isoformat(), max_age_hours=args.max_age_hours)
    feats_all = build_features(sp500, vix)
    feats = feats_all[feats_all.index >= start]
    if len(feats) < 500:
        raise SystemExit(f"only {len(feats)} feature rows in the training window; refusing to fit")
    try:
        model, scaler, labels, provisional, drift, ct_all, loglik_all = prepare_model(
            feats, seed=args.seed, n_iter=args.n_iter, tol=args.tol, version=args.version
        )
    except LabelingError as exc:
        raise SystemExit(f"LabelingError: {exc}\nRetrain with another --seed; never relabel by hand.") from exc
    score_all = float(model.score(standardize(feats[list(FEATURES)].to_numpy(dtype=float), from_export(provisional))))
    if abs(loglik_all - score_all) > 1e-8 * max(1.0, abs(score_all)):
        raise SystemExit(f"parity failure on the training sequence: {loglik_all!r} vs {score_all!r}")
    trained_through = feats.index[-1].date()
    training = {
        "trainingStart": feats.index[0].date().isoformat(),
        "trainedThrough": trained_through.isoformat(),
        "retrainBy": (trained_through + dt.timedelta(days=RETRAIN_AFTER_DAYS)).isoformat(),
        "retrainAfterDays": RETRAIN_AFTER_DAYS,
        "nObs": int(len(feats)),
        "seed": args.seed,
        "nIter": args.n_iter,
        "tol": args.tol,
        "converged": bool(model.monitor_.converged),
        "iterations": int(model.monitor_.iter),
        "logLikelihood": score_all,
        "dataSha256": data_sha256(sp500[sp500.index <= feats.index[-1]], vix[vix.index <= feats.index[-1]]),
        "hmmlearnVersion": hmmlearn.__version__,
        "sklearnVersion": sklearn.__version__,
        "numpyVersion": np.__version__,
        "pandasVersion": pd.__version__,
        "pythonVersion": platform.python_version(),
        "trainedAt": dt.datetime.now(dt.timezone.utc).replace(microsecond=0).isoformat(),
    }
    export = to_export(model, scaler, labels, version=args.version, training=training, drift=drift)
    params = from_export(export)
    fixture = build_fixture(model, params, feats, sp500, vix, args.fixture_window, args.version)

    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    (out / "regimeModel.json").write_text(json.dumps(export, indent=2) + "\n")
    (out / "regimeModel.fixture.json").write_text(json.dumps(fixture, indent=2) + "\n")
    report_dir = Path(args.report_dir)
    report_dir.mkdir(parents=True, exist_ok=True)
    report = report_dir / f"regime-{trained_through.isoformat()}.md"
    write_report(report, export, model, scaler, feats, labels, ct_all)

    print(f"trained {args.version} on {len(feats)} sessions {training['trainingStart']} → {training['trainedThrough']}")
    print(f"labels: { {k: labels[k] for k in sorted(labels)} }")
    print(f"converged={training['converged']} iterations={training['iterations']} loglik={score_all:.4f}")
    print(f"drift p5={drift['p5']:.4f} median={drift['median']:.4f}")
    print(f"wrote {out / 'regimeModel.json'}, {out / 'regimeModel.fixture.json'}, {report}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
