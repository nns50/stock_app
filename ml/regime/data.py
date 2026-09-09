"""FRED daily closes for the regime model: fetch, parse, cache.

The runtime (server/src/services/fredSeries.ts) reads the SAME two series from
the SAME endpoint, so training and inference see identical numbers by
construction. Keep the parsing rules here and there in step:

* the CSV header must be exactly ``observation_date,<SERIES_ID>``;
* a ``.`` value is a market holiday / missing print and is dropped;
* dates are sorted ascending and de-duplicated (the last row wins).

FRED publishes the S&P 500 close the next business morning and VIXCLS often a
day after that, so "today" is never in the data; the model card documents the
lag and the runtime's staleness rule accounts for it.
"""

from __future__ import annotations

import hashlib
import time
import urllib.request
from pathlib import Path

import pandas as pd

FRED_CSV_URL = "https://fred.stlouisfed.org/graph/fredgraph.csv"
SP500_SERIES = "SP500"
VIX_SERIES = "VIXCLS"
CACHE_DIR = Path(__file__).resolve().parents[1] / "data" / "cache"
USER_AGENT = "stock-app-regime-model/1.0 (+https://github.com/nns50/stock_app)"


class FredError(RuntimeError):
    """The CSV did not look like the FRED series we asked for."""


def parse_fred_csv(text: str, series_id: str) -> pd.Series:
    """Parse one FRED ``fredgraph.csv`` body into a float Series indexed by date.

    Raises :class:`FredError` on an empty body, a header that names another
    series, or a malformed row -- never guesses. Holiday rows (``.``) are
    dropped, dates sorted, duplicates resolved to the last occurrence.
    """
    lines = [line.strip() for line in text.strip().splitlines()]
    if not lines:
        raise FredError(f"{series_id}: empty body")
    expected = f"observation_date,{series_id}"
    if lines[0] != expected:
        raise FredError(f"{series_id}: unexpected header {lines[0]!r} (expected {expected!r})")
    dates: list[str] = []
    values: list[float] = []
    for line in lines[1:]:
        if not line:
            continue
        parts = line.split(",")
        if len(parts) != 2:
            raise FredError(f"{series_id}: malformed row {line!r}")
        date, value = parts[0].strip(), parts[1].strip()
        if value in (".", ""):
            continue
        try:
            values.append(float(value))
        except ValueError as exc:
            raise FredError(f"{series_id}: non-numeric value {value!r} on {date}") from exc
        dates.append(date)
    series = pd.Series(values, index=pd.to_datetime(dates), name=series_id, dtype="float64")
    series = series[~series.index.duplicated(keep="last")].sort_index()
    series.index.name = "date"
    return series


def fetch_fred_series(
    series_id: str,
    start: str,
    *,
    max_age_hours: float = 12.0,
    cache_dir: Path = CACHE_DIR,
    timeout: float = 30.0,
) -> pd.Series:
    """Fetch ``series_id`` from ``start`` (YYYY-MM-DD), caching the raw CSV.

    A cached body younger than ``max_age_hours`` is reused; a fresh body is
    validated by :func:`parse_fred_csv` BEFORE it is written to the cache, so a
    bad response can never poison later runs.
    """
    cache_dir.mkdir(parents=True, exist_ok=True)
    cache_file = cache_dir / f"{series_id}-{start}.csv"
    if cache_file.exists() and (time.time() - cache_file.stat().st_mtime) < max_age_hours * 3600:
        return parse_fred_csv(cache_file.read_text(), series_id)
    url = f"{FRED_CSV_URL}?id={series_id}&cosd={start}"
    request = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    with urllib.request.urlopen(request, timeout=timeout) as response:  # noqa: S310 - fixed https host
        text = response.read().decode("utf-8")
    series = parse_fred_csv(text, series_id)
    cache_file.write_text(text)
    return series


def load_series(start: str, end: str | None = None, **kwargs) -> tuple[pd.Series, pd.Series]:
    """Both series from ``start``, optionally truncated at ``end`` (inclusive)."""
    sp500 = fetch_fred_series(SP500_SERIES, start, **kwargs)
    vix = fetch_fred_series(VIX_SERIES, start, **kwargs)
    if end is not None:
        end_ts = pd.Timestamp(end)
        sp500 = sp500[sp500.index <= end_ts]
        vix = vix[vix.index <= end_ts]
    return sp500, vix


def data_sha256(sp500: pd.Series, vix: pd.Series) -> str:
    """A digest of exactly the rows a fit saw, recorded in the artifact."""
    digest = hashlib.sha256()
    for name, series in ((SP500_SERIES, sp500), (VIX_SERIES, vix)):
        digest.update(f"{name}\n".encode())
        for date, value in series.items():
            digest.update(f"{date.date().isoformat()},{value!r}\n".encode())
    return digest.hexdigest()
