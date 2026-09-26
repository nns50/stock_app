"""The CBOE fill for FRED's late VIX (2026-09-26), by the runtime's rule.

server/src/services/cboeVix.ts fills the VIX days FRED has not published yet
from CBOE's own file; ``regime:predict`` must read the same numbers or the
parity check fails on every filled day. These pin the Python half of that rule.
"""

from __future__ import annotations

import pandas as pd
import pytest

from ml.regime import data
from ml.regime.data import FredError, fill_vix_tail, parse_cboe_vix_csv

CBOE_BODY = (
    "DATE,OPEN,HIGH,LOW,CLOSE\n"
    "09/21/2026,14.960000,15.130000,14.600000,14.870000\n"
    "09/18/2026,15.070000,15.630000,14.800000,14.810000\n"
    "09/22/2026,14.640000,14.950000,14.190000,14.210000\n"
    "09/23/2026,14.160000,15.450000,14.120000,15.180000\n"
    "09/24/2026,15.830000,16.570000,15.340000,15.670000\n"
    "09/25/2026,15.610000,15.940000,14.680000,14.870000\n"
)


def series(values: dict[str, float], name: str = "VIXCLS") -> pd.Series:
    s = pd.Series(list(values.values()), index=pd.to_datetime(list(values)), name=name, dtype="float64")
    s.index.name = "date"
    return s


FRED_VIX = series({"2026-09-16": 15.2, "2026-09-17": 15.44, "2026-09-18": 14.81, "2026-09-21": 14.87, "2026-09-22": 14.21})


def cboe_full() -> pd.Series:
    return series(
        {
            "2026-09-16": 15.2,
            "2026-09-17": 15.44,
            "2026-09-18": 14.81,
            "2026-09-21": 14.87,
            "2026-09-22": 14.21,
            "2026-09-23": 15.18,
            "2026-09-24": 15.67,
            "2026-09-25": 14.87,
        }
    )


def test_parse_reads_the_close_by_iso_date_in_order():
    s = parse_cboe_vix_csv(CBOE_BODY)
    assert [d.date().isoformat() for d in s.index] == [
        "2026-09-18",
        "2026-09-21",
        "2026-09-22",
        "2026-09-23",
        "2026-09-24",
        "2026-09-25",
    ]
    assert s["2026-09-22"] == 14.21
    # The same double FRED's "14.21" parses to: the parity check needs exact.
    assert s["2026-09-22"] == float("14.21")


@pytest.mark.parametrize(
    "body, message",
    [
        ("", "empty body"),
        ("DATE,CLOSE\n09/22/2026,14.21\n", "unexpected header"),
        ("DATE,OPEN,HIGH,LOW,CLOSE\n09/22/2026,1,2,3\n", "malformed row"),
        ("DATE,OPEN,HIGH,LOW,CLOSE\n2026-09-22,1,2,3,4\n", "malformed date"),
        ("DATE,OPEN,HIGH,LOW,CLOSE\n09/22/2026,1,2,3,x\n", "bad close"),
        ("DATE,OPEN,HIGH,LOW,CLOSE\n09/22/2026,1,2,3,0\n", "bad close"),
    ],
)
def test_parse_refuses_anything_but_that_file(body, message):
    with pytest.raises(FredError, match=message):
        parse_cboe_vix_csv(body)


def test_fill_adds_only_the_days_after_fred_through_the_sp500s_last_day():
    vix, filled, refused = fill_vix_tail(FRED_VIX, cboe_full(), pd.Timestamp("2026-09-24"))
    assert refused is None
    assert filled == ["2026-09-23", "2026-09-24"]
    assert vix.index[-1] == pd.Timestamp("2026-09-24")
    assert vix["2026-09-23"] == 15.18
    # FRED's own days are FRED's.
    pd.testing.assert_series_equal(vix.iloc[: len(FRED_VIX)], FRED_VIX)
    assert vix.name == "VIXCLS"


def test_fill_never_replaces_a_fred_value_outside_the_checked_days():
    fred = pd.concat([series({"2026-09-15": 16.0}), FRED_VIX])
    cboe = pd.concat([series({"2026-09-15": 99.0}), cboe_full()])  # 09-15 is older than the five checked days
    vix, filled, refused = fill_vix_tail(fred, cboe, pd.Timestamp("2026-09-25"))
    assert refused is None
    assert filled == ["2026-09-23", "2026-09-24", "2026-09-25"]
    assert vix["2026-09-15"] == 16.0


def test_fill_is_refused_when_the_two_disagree_on_a_shared_day():
    cboe = cboe_full().copy()
    cboe["2026-09-21"] = 14.88
    vix, filled, refused = fill_vix_tail(FRED_VIX, cboe, pd.Timestamp("2026-09-25"))
    assert filled == []
    assert "differs" in refused
    pd.testing.assert_series_equal(vix, FRED_VIX)


def test_fill_is_refused_when_cboe_lacks_one_of_freds_latest_days():
    cboe = cboe_full().drop(pd.Timestamp("2026-09-18"))
    vix, filled, refused = fill_vix_tail(FRED_VIX, cboe, pd.Timestamp("2026-09-25"))
    assert filled == []
    assert "no close for 2026-09-18" in refused
    pd.testing.assert_series_equal(vix, FRED_VIX)


def test_fill_is_refused_when_cboe_has_nothing_newer_either():
    vix, filled, refused = fill_vix_tail(FRED_VIX, FRED_VIX, pd.Timestamp("2026-09-25"))
    assert filled == []
    assert refused == "CBOE has no close after 2026-09-22 either"
    pd.testing.assert_series_equal(vix, FRED_VIX)


def test_nothing_to_fill_when_fred_is_current():
    vix, filled, refused = fill_vix_tail(FRED_VIX, cboe_full(), pd.Timestamp("2026-09-22"))
    assert (filled, refused) == ([], None)
    pd.testing.assert_series_equal(vix, FRED_VIX)


SP500_TO_0925 = series(
    {d: 6000.0 + i for i, d in enumerate(["2026-09-22", "2026-09-23", "2026-09-24", "2026-09-25"])}, "SP500"
)


def pin_today(monkeypatch, day: str) -> None:
    """A reading's fill depends on today's date; never read the wall clock."""
    monkeypatch.setattr(data, "et_today", lambda: pd.Timestamp(day))


def test_load_series_fills_only_when_asked(monkeypatch):
    sp500 = SP500_TO_0925
    pin_today(monkeypatch, "2026-09-26")
    monkeypatch.setattr(
        data, "fetch_fred_series", lambda series_id, start, **kw: sp500 if series_id == "SP500" else FRED_VIX
    )
    monkeypatch.setattr(data, "fetch_cboe_vix", lambda **kw: cboe_full())
    _, vix = data.load_series("2026-09-01", vix_tail_from_cboe=True)
    assert vix.index[-1] == pd.Timestamp("2026-09-25")
    # Training asks without the flag and reads FRED's days only.
    _, trained_on = data.load_series("2026-09-01")
    pd.testing.assert_series_equal(trained_on, FRED_VIX)
    # A reading as of an earlier day still ends on that day.
    _, as_of = data.load_series("2026-09-01", end="2026-09-24", vix_tail_from_cboe=True)
    assert as_of.index[-1] == pd.Timestamp("2026-09-24")


def test_the_fill_never_reaches_today(monkeypatch):
    """Friday evening, with FRED's S&P 500 already carrying Friday: CBOE's row
    for today may not be the final close yet, so the fill stops a day short."""
    pin_today(monkeypatch, "2026-09-25")
    monkeypatch.setattr(
        data, "fetch_fred_series", lambda series_id, start, **kw: SP500_TO_0925 if series_id == "SP500" else FRED_VIX
    )
    monkeypatch.setattr(data, "fetch_cboe_vix", lambda **kw: cboe_full())
    _, vix = data.load_series("2026-09-01", vix_tail_from_cboe=True)
    assert vix.index[-1] == pd.Timestamp("2026-09-24")
    assert data.vix_fill_through(pd.Timestamp("2026-09-25"), pd.Timestamp("2026-09-26")) == pd.Timestamp("2026-09-25")


def test_a_cached_cboe_file_that_ends_early_is_fetched_again(monkeypatch):
    """The server fills from a fresh fetch; a 12-hour-old cache could end a day
    earlier, and the parity check would then disagree on asOf."""
    pin_today(monkeypatch, "2026-09-26")
    monkeypatch.setattr(
        data, "fetch_fred_series", lambda series_id, start, **kw: SP500_TO_0925 if series_id == "SP500" else FRED_VIX
    )
    calls: list[dict] = []

    def cboe(**kw):
        calls.append(kw)
        full = cboe_full()
        return full if kw.get("max_age_hours") == 0.0 else full[full.index <= pd.Timestamp("2026-09-23")]

    monkeypatch.setattr(data, "fetch_cboe_vix", cboe)
    _, vix = data.load_series("2026-09-01", vix_tail_from_cboe=True)
    assert vix.index[-1] == pd.Timestamp("2026-09-25")
    assert [c.get("max_age_hours") for c in calls] == [None, 0.0]


def test_load_series_keeps_freds_days_when_cboe_is_unreadable(monkeypatch, capsys):
    pin_today(monkeypatch, "2026-09-26")
    sp500 = series({"2026-09-22": 6000.0, "2026-09-25": 6010.0}, "SP500")
    monkeypatch.setattr(
        data, "fetch_fred_series", lambda series_id, start, **kw: sp500 if series_id == "SP500" else FRED_VIX
    )

    def down(**kw):
        raise OSError("connection reset")

    monkeypatch.setattr(data, "fetch_cboe_vix", down)
    _, vix = data.load_series("2026-09-01", vix_tail_from_cboe=True)
    pd.testing.assert_series_equal(vix, FRED_VIX)
    assert "CBOE VIX unavailable" in capsys.readouterr().err


def test_a_reading_asks_for_the_fill(monkeypatch):
    """regime:predict reads through get_market_regime; it must ask for the
    runtime's fill, or every filled day fails the parity check."""
    from ml.regime import infer

    seen: dict[str, object] = {}

    def fake_load_series(start, end=None, **kw):
        seen.update(kw)
        raise RuntimeError("stop here")

    monkeypatch.setattr(data, "load_series", fake_load_series)
    with pytest.raises(RuntimeError, match="stop here"):
        infer.get_market_regime(as_of="2026-09-25")
    assert seen.get("vix_tail_from_cboe") is True
