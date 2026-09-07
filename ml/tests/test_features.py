import numpy as np
import pandas as pd

from ml.regime.data import parse_fred_csv
from ml.regime.features import FEATURES, RV_WINDOW, build_features


def test_first_feature_row_is_the_21st_close_and_values_match_numpy():
    dates = pd.bdate_range("2024-01-01", periods=30)
    closes = pd.Series(100.0 * np.exp(np.cumsum(np.linspace(-0.01, 0.02, 30))), index=dates)
    vix = pd.Series(np.linspace(12, 20, 30), index=dates)
    feats = build_features(closes, vix)
    assert list(feats.columns) == list(FEATURES)
    assert feats.index[0] == dates[RV_WINDOW]
    assert len(feats) == 30 - RV_WINDOW
    log_ret = np.diff(np.log(closes.to_numpy()))
    assert np.isclose(feats["ret"].iloc[0], log_ret[RV_WINDOW - 1])
    assert np.isclose(feats["logRv20"].iloc[0], np.log(np.std(log_ret[:RV_WINDOW], ddof=1)))
    assert np.isclose(feats["logVix"].iloc[0], np.log(vix.iloc[RV_WINDOW]))


def test_vix_hole_drops_the_row_but_not_the_return_chain():
    dates = pd.bdate_range("2024-01-01", periods=30)
    closes = pd.Series(np.linspace(100, 130, 30), index=dates)
    vix = pd.Series(15.0, index=dates).drop(dates[25])
    feats = build_features(closes, vix)
    assert dates[25] not in feats.index
    # The return on the day after the hole is still close-to-close over ONE
    # session (computed on the S&P's own rows), not a two-day jump.
    expected = np.log(closes.iloc[26] / closes.iloc[25])
    assert np.isclose(feats.loc[dates[26], "ret"], expected)


def test_sp500_hole_makes_a_two_session_return():
    dates = pd.bdate_range("2024-01-01", periods=30)
    closes = pd.Series(np.linspace(100, 130, 30), index=dates).drop(dates[25])
    vix = pd.Series(15.0, index=dates)
    feats = build_features(closes, vix)
    expected = np.log(closes.loc[dates[26]] / closes.loc[dates[24]])
    assert np.isclose(feats.loc[dates[26], "ret"], expected)


def test_parse_fred_csv_rules():
    text = "observation_date,VIXCLS\n2024-01-03,13.0\n2024-01-02,12.5\n2024-01-04,.\n2024-01-03,13.5\n"
    s = parse_fred_csv(text, "VIXCLS")
    assert [d.date().isoformat() for d in s.index] == ["2024-01-02", "2024-01-03"]
    assert s.iloc[1] == 13.5  # duplicate: last wins
    import pytest

    from ml.regime.data import FredError

    with pytest.raises(FredError):
        parse_fred_csv("observation_date,SP500\n2024-01-02,1\n", "VIXCLS")
    with pytest.raises(FredError):
        parse_fred_csv("", "VIXCLS")
    with pytest.raises(FredError):
        parse_fred_csv("observation_date,VIXCLS\n2024-01-02,abc\n", "VIXCLS")
