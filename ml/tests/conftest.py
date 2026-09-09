"""Shared fixtures: a synthetic three-regime series and a fitted model on it."""

from __future__ import annotations

import numpy as np
import pandas as pd
import pytest

from ml.regime.features import build_features
from ml.regime.model import fit_hmm, label_states


def synthetic_series(n_days: int = 1200, seed: int = 3) -> tuple[pd.Series, pd.Series]:
    """S&P-like closes and a VIX-like series driven by three planted regimes.

    Regime 0: calm, drifting up (bullish). Regime 1: choppy, flat (sideways).
    Regime 2: stressed, drifting down (bearish). Regimes persist ~80 sessions.
    """
    rng = np.random.default_rng(seed)
    drift = {0: 0.0012, 1: -0.0002, 2: -0.0025}
    vol = {0: 0.005, 1: 0.011, 2: 0.025}
    vix = {0: 12.0, 1: 20.0, 2: 36.0}
    regime = 0
    rets, vixes = [], []
    for _ in range(n_days):
        if rng.random() < 1 / 80:
            regime = int(rng.choice([r for r in (0, 1, 2) if r != regime]))
        rets.append(rng.normal(drift[regime], vol[regime]))
        vixes.append(max(9.0, vix[regime] * np.exp(rng.normal(0, 0.05))))
    dates = pd.bdate_range("2020-01-01", periods=n_days)
    closes = 3000.0 * np.exp(np.cumsum(rets))
    return pd.Series(closes, index=dates, name="SP500"), pd.Series(vixes, index=dates, name="VIXCLS")


@pytest.fixture(scope="session")
def synthetic():
    return synthetic_series()


@pytest.fixture(scope="session")
def synthetic_features(synthetic):
    return build_features(*synthetic)


@pytest.fixture(scope="session")
def fitted(synthetic_features):
    model, scaler = fit_hmm(synthetic_features.to_numpy(dtype=float), seed=7, n_iter=300)
    labels = label_states(model, scaler)
    return model, scaler, labels
