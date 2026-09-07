"""Walk-forward, OUT-OF-SAMPLE evaluation over all the history FRED serves.

    python -m ml.regime.evaluate --version 2026.09.1 [--end YYYY-MM-DD]
        [--train-years 5] [--min-train-years 3] [--refit-months 3] [--threshold 0.6]

Every quarter a fresh model is fitted on the trailing (up to) five years, its
states re-labeled by the same rule, and each session of that quarter is then
classified exactly as the runtime would classify it: a 250-row window ending
on that session, forward-filtered from the stationary prior, sticky-switched
from the previous session's regime. Nothing in a session's reading has seen
that session's future -- no in-sample fit, no Viterbi/forward-backward
smoothing. That path is written to ``server/data/regimeHistory.json`` for the
backtest (which shifts it one session, the morning FRED publishes) and its
statistics to ``ml/reports/regime-eval-<end>.md``.

FRED's SP500 series only serves the most recent ten years, so the first refits
train on three-to-five years (``--min-train-years``); the report says which.
A ``LabelingError`` on ANY refit aborts the whole run rather than guessing.
"""

from __future__ import annotations

import argparse
import datetime as dt
import json
from pathlib import Path

import numpy as np
import pandas as pd

from .data import load_series
from .features import FEATURES, build_features
from .infer import LABELS, UNKNOWN, classify, from_export
from .model import LabelingError
from .report import bootstrap_mean_ci, fmt, md_table
from .train import DEFAULT_OUT, DEFAULT_REPORT_DIR, WARMUP_CALENDAR_DAYS, prepare_model

HORIZONS = (1, 5, 20)
KNOWN_EPISODES = [
    # (name, start, end, minimum share of OOS sessions in high_vol_bearish)
    ("COVID crash", "2020-02-24", "2020-04-30", 0.5),
    ("2022 bear market", "2022-01-03", "2022-10-12", 0.5),
]
VIX_PEAKS = [
    # (name, date, sessions allowed for high_vol_bearish to appear)
    ("Aug-2024 vol spike", "2024-08-05", 2),
    ("Apr-2025 tariff shock", "2025-04-08", 2),
]


def parse_args(argv: list[str] | None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Walk-forward out-of-sample evaluation of the regime HMM.")
    parser.add_argument("--version", required=True)
    parser.add_argument("--end", default=None)
    parser.add_argument("--train-years", type=int, default=5)
    parser.add_argument("--min-train-years", type=int, default=3)
    parser.add_argument("--refit-months", type=int, default=3)
    parser.add_argument("--threshold", type=float, default=0.6)
    parser.add_argument("--seed", type=int, default=7)
    parser.add_argument("--n-iter", type=int, default=500)
    parser.add_argument("--tol", type=float, default=1e-4)
    parser.add_argument("--out", default=str(DEFAULT_OUT))
    parser.add_argument("--report-dir", default=str(DEFAULT_REPORT_DIR))
    parser.add_argument("--max-age-hours", type=float, default=12.0)
    return parser.parse_args(argv)


def quarter_starts(first: pd.Timestamp, end: pd.Timestamp, months: int) -> list[pd.Timestamp]:
    starts = []
    cursor = pd.Timestamp(year=first.year, month=first.month, day=1)
    while cursor <= end:
        starts.append(cursor)
        cursor = cursor + pd.DateOffset(months=months)
    return starts


def walk_forward(feats: pd.DataFrame, args: argparse.Namespace) -> tuple[dict[str, dict], list[dict]]:
    """Per-session OOS readings keyed by data date, plus one row per refit."""
    data_start = feats.index[0]
    end = feats.index[-1]
    first_eval = data_start + pd.DateOffset(years=args.min_train_years)
    days: dict[str, dict] = {}
    refits: list[dict] = []
    previous: str | None = None
    for q_start in quarter_starts(first_eval, end, args.refit_months):
        q_end = q_start + pd.DateOffset(months=args.refit_months)
        train = feats[(feats.index >= q_start - pd.DateOffset(years=args.train_years)) & (feats.index < q_start)]
        try:
            model, scaler, labels, provisional, drift, _, _ = prepare_model(
                train, seed=args.seed, n_iter=args.n_iter, tol=args.tol, version=args.version
            )
        except LabelingError as exc:
            raise SystemExit(f"LabelingError on the refit at {q_start.date()}: {exc}") from exc
        export = dict(provisional)
        export["drift"] = drift
        params = from_export(export)
        refits.append(
            {
                "refit": q_start.date().isoformat(),
                "trainStart": train.index[0].date().isoformat(),
                "trainEnd": train.index[-1].date().isoformat(),
                "nObs": int(len(train)),
                "converged": bool(model.monitor_.converged),
                "labels": {str(k): v for k, v in sorted(labels.items())},
                "driftP5": drift["p5"],
            }
        )
        in_quarter = feats[(feats.index >= q_start) & (feats.index < q_end)]
        for date in in_quarter.index:
            window = feats[feats.index <= date]
            reading = classify(params, window, previous=previous, threshold=args.threshold)
            days[date.date().isoformat()] = {
                "regime": reading.regime,
                "argmax": reading.candidate,
                "p": {k: round(v, 6) for k, v in reading.probabilities.items()},
                "held": reading.held_below_threshold,
                "switched": reading.switched,
                "drift": reading.drift,
                "driftScore": None if reading.drift_score is None else round(reading.drift_score, 4),
                "refit": q_start.date().isoformat(),
            }
            # The sticky chain carries the LAST KNOWN regime, as the runtime
            # does (db.getPreviousKnownMlRegime).
            if reading.regime != UNKNOWN:
                previous = reading.regime
    return days, refits


def forward_stats(feats: pd.DataFrame, days: dict[str, dict], key: str) -> list[list[object]]:
    """Per regime: sessions, mean next-k log returns with CIs, next-20 realized vol."""
    ret = feats["ret"]
    dates = list(ret.index)
    pos = {d.date().isoformat(): i for i, d in enumerate(dates)}
    fwd = {h: ret.rolling(h).sum().shift(-h) for h in HORIZONS}
    fwd_vol = ret.rolling(20).std(ddof=1).shift(-20)
    uncond_median_vol = float(fwd_vol.dropna().median())
    rows = []
    for label in LABELS:
        members = [d for d, r in days.items() if r[key] == label and d in pos]
        idx = [pos[d] for d in members]
        row: list[object] = [label, len(members)]
        for h in HORIZONS:
            vals = [float(fwd[h].iloc[i]) for i in idx if not np.isnan(fwd[h].iloc[i])]
            mean, lo, hi = bootstrap_mean_ci(vals)
            row.append(f"{fmt(100 * mean, 3)}% [{fmt(100 * lo, 3)}, {fmt(100 * hi, 3)}]")
        vols = [float(fwd_vol.iloc[i]) for i in idx if not np.isnan(fwd_vol.iloc[i])]
        mean, lo, hi = bootstrap_mean_ci(vols)
        row.append(f"{fmt(100 * mean, 3)}% [{fmt(100 * lo, 3)}, {fmt(100 * hi, 3)}]")
        share = float(np.mean([v > uncond_median_vol for v in vols])) if vols else float("nan")
        row.append(fmt(100 * share, 1) + "%")
        rows.append(row)
    return rows


def transition_stats(days: dict[str, dict]) -> dict[str, float]:
    ordered = [days[d] for d in sorted(days)]
    n = len(ordered)
    switches = sum(1 for r in ordered if r["switched"])
    held = sum(1 for r in ordered if r["held"])
    drift = sum(1 for r in ordered if r["drift"])
    years = n / 252.0
    dwell_lengths = []
    run = 0
    last = None
    for r in ordered:
        if r["regime"] == last:
            run += 1
        else:
            if run:
                dwell_lengths.append(run)
            run = 1
            last = r["regime"]
    if run:
        dwell_lengths.append(run)
    return {
        "sessions": n,
        "years": years,
        "switchesPerYear": switches / years if years else float("nan"),
        "meanDwellSessions": float(np.mean(dwell_lengths)) if dwell_lengths else float("nan"),
        "heldBelowThresholdShare": held / n if n else float("nan"),
        "driftShare": drift / n if n else float("nan"),
        "driftSessions": drift,
    }


def episode_checks(days: dict[str, dict]) -> list[list[object]]:
    rows = []
    ordered = sorted(days)
    for name, start, end, minimum in KNOWN_EPISODES:
        in_ep = [days[d] for d in ordered if start <= d <= end]
        if not in_ep:
            rows.append([name, f"{start} → {end}", "no OOS sessions", "n/a", "n/a"])
            continue
        share = float(np.mean([r["regime"] == "high_vol_bearish" for r in in_ep]))
        rows.append([name, f"{start} → {end}", f"{100 * share:.1f}% high_vol_bearish", f"≥ {100 * minimum:.0f}%", "pass" if share >= minimum else "FAIL"])
    for name, date, allowed in VIX_PEAKS:
        after = [d for d in ordered if d >= date][: allowed + 1]
        if not after:
            rows.append([name, date, "no OOS sessions", f"within {allowed} sessions", "n/a"])
            continue
        hit = next((d for d in after if days[d]["regime"] == "high_vol_bearish"), None)
        rows.append([name, date, f"high_vol_bearish on {hit}" if hit else "not reached", f"within {allowed} sessions", "pass" if hit else "FAIL"])
    return rows


def drift_episode_rows(days: dict[str, dict]) -> list[list[object]]:
    rows = []
    for name, start, end, _ in KNOWN_EPISODES:
        in_ep = [days[d] for d in sorted(days) if start <= d <= end]
        fired = sum(1 for r in in_ep if r["drift"])
        rows.append([name, len(in_ep), fired, "n/a" if not in_ep else f"{100 * fired / len(in_ep):.1f}%"])
    return rows


def write_report(path: Path, args, feats, days, refits, version: str) -> dict:
    stats = transition_stats(days)
    summary = {
        "version": version,
        "from": min(days),
        "to": max(days),
        "sessions": stats["sessions"],
        "refits": len(refits),
        "switchesPerYear": stats["switchesPerYear"],
        "meanDwellSessions": stats["meanDwellSessions"],
        "heldBelowThresholdShare": stats["heldBelowThresholdShare"],
        "driftShare": stats["driftShare"],
        "episodes": episode_checks(days),
    }
    headers = ["regime", "sessions"] + [f"next-{h}d mean log ret [95% CI]" for h in HORIZONS] + [
        "next-20d realized vol [95% CI]",
        "share > unconditional median vol",
    ]
    lines = [
        f"# Regime model {version} — walk-forward out-of-sample evaluation",
        "",
        "Generated by `python -m ml.regime.evaluate`. Every session below was classified by a model",
        "that had not seen it: refits every quarter on the trailing (up to) five years, forward-FILTERED",
        f"readings on a 250-row window, sticky switch at {args.threshold}. Returns are daily log returns.",
        "",
        "## Coverage",
        "",
        md_table(
            ["field", "value"],
            [
                ["OOS sessions", f"{summary['sessions']} ({summary['from']} → {summary['to']})"],
                ["refits", str(len(refits))],
                ["first refit trained on", f"{refits[0]['trainStart']} → {refits[0]['trainEnd']} ({refits[0]['nObs']} sessions)"],
                ["last refit trained on", f"{refits[-1]['trainStart']} → {refits[-1]['trainEnd']} ({refits[-1]['nObs']} sessions)"],
                ["refits that did not converge", str(sum(1 for r in refits if not r["converged"]))],
            ],
        ),
        "",
        "## Forward returns and volatility by regime — sticky path (what the runtime reads)",
        "",
        md_table(headers, forward_stats(feats, days, "regime")),
        "",
        "## Forward returns and volatility by regime — argmax path (no sticky switch)",
        "",
        md_table(headers, forward_stats(feats, days, "argmax")),
        "",
        "**The gate**: next-20-day realized vol in `high_vol_bearish` vs `low_vol_bullish` with",
        "non-overlapping CIs. Overlapping intervals mean the model is not predictive of volatility",
        "and the overlay must not be enabled. Forward returns are reported but are not the gate;",
        "\"Bearish\" describes the fitted mean, as the model card says.",
        "",
        "## Transitions (sticky path)",
        "",
        md_table(
            ["statistic", "value"],
            [
                ["switches per year", fmt(stats["switchesPerYear"], 2)],
                ["mean dwell (sessions)", fmt(stats["meanDwellSessions"], 1)],
                ["sessions held below threshold", f"{100 * stats['heldBelowThresholdShare']:.1f}%"],
                ["drift flag fired", f"{stats['driftSessions']} sessions ({100 * stats['driftShare']:.1f}%)"],
            ],
        ),
        "",
        "A sticky path that switches more than ~10×/year fails the enabling rule.",
        "",
        "## Known-episode check",
        "",
        md_table(["episode", "window", "result", "rule", "verdict"], summary["episodes"]),
        "",
        "A spike shorter than the 20-day realized-vol window (Aug-2024: VIX 38 → 23 within three",
        "sessions) is read as Sideways by a daily-close model — that is the documented limit of these",
        "features, and the case the intraday range nowcast (`regimeShockRangeRatio`) covers at the open.",
        "A grind (2022) or a crash (2020) that lasts longer than the window must read High Vol.",
        "",
        "## Drift flag inside the known episodes",
        "",
        "The flag is a RETRAIN SIGNAL, not a gate — the regime label stands while it is raised. It must",
        "fire in the COVID crash (the tape leaves every calm model's distribution) and rarely elsewhere;",
        "a flag that fires monthly is a model too narrow to ship.",
        "",
        md_table(["episode", "OOS sessions", "drift sessions", "share"], drift_episode_rows(days)),
        "",
        "## Refits",
        "",
        md_table(
            ["refit", "trained on", "sessions", "converged", "labels (state → label)", "drift p5"],
            [
                [
                    r["refit"],
                    f"{r['trainStart']} → {r['trainEnd']}",
                    r["nObs"],
                    r["converged"],
                    ", ".join(f"{k}→{v}" for k, v in r["labels"].items()),
                    fmt(r["driftP5"], 3),
                ]
                for r in refits
            ],
        ),
        "",
    ]
    path.write_text("\n".join(lines))
    return summary


def dump_history(history: dict) -> str:
    """One session per line, so a retrain's diff reads as changed days."""
    lines = ["{"]
    for key, value in history.items():
        if key == "days":
            continue
        lines.append(f"  {json.dumps(key)}: {json.dumps(value)},")
    lines.append('  "days": {')
    items = list(history["days"].items())
    for i, (date, row) in enumerate(items):
        comma = "," if i < len(items) - 1 else ""
        lines.append(f"    {json.dumps(date)}: {json.dumps(row, separators=(', ', ': '))}{comma}")
    lines.append("  }")
    lines.append("}")
    return "\n".join(lines) + "\n"


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)
    end = pd.Timestamp(args.end) if args.end else pd.Timestamp.today().normalize()
    # Ask for more than FRED serves; SP500 comes back from whatever its first
    # available date is (ten years back), VIXCLS from the requested start.
    fetch_start = (end - pd.DateOffset(years=12) - pd.Timedelta(days=WARMUP_CALENDAR_DAYS)).date().isoformat()
    sp500, vix = load_series(fetch_start, end=end.date().isoformat(), max_age_hours=args.max_age_hours)
    feats = build_features(sp500, vix)
    days, refits = walk_forward(feats, args)
    if not days:
        raise SystemExit("no out-of-sample sessions produced; is the history long enough?")
    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    history = {
        "version": args.version,
        "method": (
            f"walk-forward: quarterly refits on the trailing {args.train_years}y (first {args.min_train_years}y), "
            f"states relabeled per refit, forward-FILTERED on a 250-row window, sticky {args.threshold}; "
            "keyed by DATA date — the backtest shifts one session for publication"
        ),
        "from": min(days),
        "to": max(days),
        "generatedAt": dt.datetime.now(dt.timezone.utc).replace(microsecond=0).isoformat(),
        "days": {d: days[d] for d in sorted(days)},
    }
    (out / "regimeHistory.json").write_text(dump_history(history))
    report_dir = Path(args.report_dir)
    report_dir.mkdir(parents=True, exist_ok=True)
    report = report_dir / f"regime-eval-{end.date().isoformat()}.md"
    summary = write_report(report, args, feats, days, refits, args.version)
    (report_dir / f"regime-eval-{end.date().isoformat()}.json").write_text(json.dumps(summary, indent=2) + "\n")
    print(f"OOS sessions {summary['sessions']} ({summary['from']} → {summary['to']}), {len(refits)} refits")
    print(f"switches/year {summary['switchesPerYear']:.2f}, mean dwell {summary['meanDwellSessions']:.1f}, drift share {100 * summary['driftShare']:.1f}%")
    for row in summary["episodes"]:
        print("  ", " | ".join(str(c) for c in row))
    print(f"wrote {out / 'regimeHistory.json'} and {report}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
