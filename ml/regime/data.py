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

VIXCLS is CBOE's own VIX close, republished, and its lag can run to days
(2026-09-26: it ended 09-22 with SP500 at 09-25). For a READING, the days
between are read from CBOE's history file (:func:`fill_vix_tail`), exactly as
the runtime does (server/src/services/cboeVix.ts), so the parity check reads
the same numbers. Training never uses the fill.
"""

from __future__ import annotations

import hashlib
import sys
import time
import urllib.request
from pathlib import Path

import pandas as pd

FRED_CSV_URL = "https://fred.stlouisfed.org/graph/fredgraph.csv"
SP500_SERIES = "SP500"
VIX_SERIES = "VIXCLS"
CBOE_VIX_CSV_URL = "https://cdn.cboe.com/api/global/us_indices/daily_prices/VIX_History.csv"
CBOE_VIX_HEADER = "DATE,OPEN,HIGH,LOW,CLOSE"
# How many of FRED's latest VIX days CBOE must carry, at exactly FRED's close,
# before its later days may extend FRED's series (cboeVix.ts VIX_FILL_OVERLAP).
VIX_FILL_OVERLAP = 5
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


def parse_cboe_vix_csv(text: str) -> pd.Series:
    """Parse CBOE's ``VIX_History.csv`` into its daily CLOSE, indexed by date.

    Raises :class:`FredError` on anything that is not that file (a changed
    layout must fail visibly), exactly as ``parseCboeVixCsv`` does at runtime.
    """
    lines = [line.strip() for line in text.strip().splitlines()]
    if not lines:
        raise FredError("CBOE VIX: empty body")
    if lines[0] != CBOE_VIX_HEADER:
        raise FredError(f"CBOE VIX: unexpected header {lines[0]!r} (expected {CBOE_VIX_HEADER!r})")
    dates: list[str] = []
    values: list[float] = []
    for line in lines[1:]:
        if not line:
            continue
        parts = line.split(",")
        if len(parts) != 5:
            raise FredError(f"CBOE VIX: malformed row {line!r}")
        month_day_year = parts[0].strip().split("/")
        if len(month_day_year) != 3 or not all(p.isdigit() for p in month_day_year):
            raise FredError(f"CBOE VIX: malformed date {parts[0]!r}")
        month, day, year = month_day_year
        try:
            close = float(parts[4].strip())
        except ValueError as exc:
            raise FredError(f"CBOE VIX: bad close {parts[4]!r} on {parts[0]}") from exc
        if not close > 0:
            raise FredError(f"CBOE VIX: bad close {parts[4]!r} on {parts[0]}")
        dates.append(f"{year}-{month}-{day}")
        values.append(close)
    series = pd.Series(values, index=pd.to_datetime(dates), name=VIX_SERIES, dtype="float64")
    series = series[~series.index.duplicated(keep="last")].sort_index()
    series.index.name = "date"
    return series


def fetch_cboe_vix(
    *,
    max_age_hours: float = 12.0,
    cache_dir: Path = CACHE_DIR,
    timeout: float = 30.0,
) -> pd.Series:
    """CBOE's whole VIX history, cached like :func:`fetch_fred_series`."""
    cache_dir.mkdir(parents=True, exist_ok=True)
    cache_file = cache_dir / "CBOE-VIX_History.csv"
    if cache_file.exists() and (time.time() - cache_file.stat().st_mtime) < max_age_hours * 3600:
        return parse_cboe_vix_csv(cache_file.read_text())
    request = urllib.request.Request(CBOE_VIX_CSV_URL, headers={"User-Agent": USER_AGENT})
    with urllib.request.urlopen(request, timeout=timeout) as response:  # noqa: S310 - fixed https host
        text = response.read().decode("utf-8")
    series = parse_cboe_vix_csv(text)
    cache_file.write_text(text)
    return series


def fill_vix_tail(
    fred: pd.Series, cboe: pd.Series, through: pd.Timestamp
) -> tuple[pd.Series, list[str], str | None]:
    """FRED's VIX extended from CBOE through ``through``, the runtime's rule.

    Returns ``(vix, filled_dates, refused)``. Only the days after FRED's last one
    are added, and none after ``through``; no FRED value is replaced. Refused,
    with FRED's series returned unchanged, when FRED is empty, when CBOE does
    not carry FRED's latest ``VIX_FILL_OVERLAP`` days at exactly FRED's closes,
    or when CBOE has no day after FRED's last one either.
    """
    if fred.empty:
        return fred, [], "FRED returned no VIX rows to extend"
    last = fred.index[-1]
    if last >= through:
        return fred, [], None
    for date, value in fred.iloc[-VIX_FILL_OVERLAP:].items():
        if date not in cboe.index:
            return fred, [], f"CBOE has no close for {date.date().isoformat()}, which FRED carries"
        if cboe[date] != value:
            return fred, [], f"CBOE's {date.date().isoformat()} close {cboe[date]} differs from FRED's {value}"
    tail = cboe[(cboe.index > last) & (cboe.index <= through)]
    if tail.empty:
        return fred, [], f"CBOE has no close after {last.date().isoformat()} either"
    filled = pd.concat([fred, tail]).rename(fred.name)
    filled.index.name = fred.index.name
    return filled, [d.date().isoformat() for d in tail.index], None


def et_today() -> pd.Timestamp:
    """Today's date in New York, as a naive midnight timestamp."""
    return pd.Timestamp.now(tz="America/New_York").normalize().tz_localize(None)


def vix_fill_through(sp500_last: pd.Timestamp, today: pd.Timestamp) -> pd.Timestamp:
    """The last day a fill may reach: FRED's last S&P 500 day, and never today
    (a day's close is final only once its session is over). The runtime's rule."""
    return min(sp500_last, today - pd.Timedelta(days=1))


def load_series(
    start: str, end: str | None = None, *, vix_tail_from_cboe: bool = False, **kwargs
) -> tuple[pd.Series, pd.Series]:
    """Both series from ``start``, optionally truncated at ``end`` (inclusive).

    ``vix_tail_from_cboe`` fills the VIX days FRED has not published yet from
    CBOE (:func:`fill_vix_tail`), through :func:`vix_fill_through`. A reading
    asks for it; training does not. A cached CBOE file that ends before those
    days is fetched again, so a reading never misses a day the server filled.
    A failed fetch or a refused fill keeps FRED's rows and says so on stderr.
    """
    sp500 = fetch_fred_series(SP500_SERIES, start, **kwargs)
    vix = fetch_fred_series(VIX_SERIES, start, **kwargs)
    if vix_tail_from_cboe and not sp500.empty and not vix.empty:
        through = vix_fill_through(sp500.index[-1], et_today())
        if vix.index[-1] < through:
            try:
                cboe = fetch_cboe_vix(**kwargs)
                if cboe.empty or cboe.index[-1] < through:
                    cboe = fetch_cboe_vix(**{**kwargs, "max_age_hours": 0.0})
                vix, _filled, refused = fill_vix_tail(vix, cboe, through)
                if refused is not None:
                    print(f"warning: VIX left at FRED's days: {refused}", file=sys.stderr)
            except (OSError, FredError) as exc:
                print(f"warning: CBOE VIX unavailable, VIX left at FRED's days: {exc}", file=sys.stderr)
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
