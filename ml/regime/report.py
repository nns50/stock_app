"""Markdown and statistics helpers shared by train.py and evaluate.py."""

from __future__ import annotations

from typing import Iterable, Sequence

import numpy as np


def fmt(value: float | None, digits: int = 4) -> str:
    if value is None or (isinstance(value, float) and np.isnan(value)):
        return "n/a"
    return f"{value:.{digits}f}"


def pct(value: float | None, digits: int = 1) -> str:
    return "n/a" if value is None or np.isnan(value) else f"{100 * value:.{digits}f}%"


def md_table(headers: Sequence[str], rows: Iterable[Sequence[object]]) -> str:
    rows = [[str(c) for c in row] for row in rows]
    widths = [len(h) for h in headers]
    for row in rows:
        for i, cell in enumerate(row):
            widths[i] = max(widths[i], len(cell))
    line = lambda cells: "| " + " | ".join(c.ljust(widths[i]) for i, c in enumerate(cells)) + " |"  # noqa: E731
    out = [line(list(headers)), "| " + " | ".join("-" * w for w in widths) + " |"]
    out.extend(line(row) for row in rows)
    return "\n".join(out)


def bootstrap_mean_ci(
    values: Sequence[float], *, n_draws: int = 2000, seed: int = 11, alpha: float = 0.05
) -> tuple[float, float, float]:
    """(mean, lower, upper) percentile bootstrap of the mean; nan triple when empty."""
    arr = np.asarray([v for v in values if v is not None and not np.isnan(v)], dtype=float)
    if arr.size == 0:
        return float("nan"), float("nan"), float("nan")
    if arr.size == 1:
        return float(arr[0]), float(arr[0]), float(arr[0])
    rng = np.random.default_rng(seed)
    draws = rng.choice(arr, size=(n_draws, arr.size), replace=True).mean(axis=1)
    lo, hi = np.percentile(draws, [100 * alpha / 2, 100 * (1 - alpha / 2)])
    return float(arr.mean()), float(lo), float(hi)
