"""The three daily features, in the ONE order every implementation must share.

``ret``     -- log return of the S&P 500 close, on the S&P 500's own rows
``logVix``  -- natural log of the VIX close
``logRv20`` -- natural log of the rolling 20-day standard deviation of ``ret``
               (ddof 1, NOT annualized)

Volatility is log-normal-ish: on the raw scale the COVID crash (rv20 ~ 4-5%)
sits so far from a calm 0.7% that a Gaussian state fitted through it is a
crash-only state, and the 2022 grind (1.2-1.6%) then reads as Sideways. On the
log scale those distances are proportional, the high-vol state covers the grind
too, and the walk-forward check on 2022 passes (66.8% vs 33.2% raw). The first
draft used the raw std; the change is recorded in ml/reports.

Returns and the rolling std are computed on the S&P 500 series alone BEFORE the
inner join with VIX, so a VIX holiday never punches a hole in a return. The
first 20 S&P 500 rows carry no ``rv20`` and fall away. The TypeScript port
(server/src/services/hmmForward.ts ``buildFeatures``) mirrors these rules and
the parity fixture proves it row for row.
"""

from __future__ import annotations

import numpy as np
import pandas as pd

FEATURES: tuple[str, ...] = ("ret", "logVix", "logRv20")
RV_WINDOW = 20


def build_features(sp500: pd.Series, vix: pd.Series) -> pd.DataFrame:
    sp = sp500.sort_index().astype("float64")
    vx = vix.sort_index().astype("float64")
    ret = np.log(sp).diff()
    rv20 = ret.rolling(RV_WINDOW).std(ddof=1)
    log_vix = np.log(vx).rename("logVix")
    frame = pd.DataFrame({"ret": ret, "logRv20": np.log(rv20)}).join(log_vix, how="inner")
    frame = frame[list(FEATURES)].dropna()
    frame.index.name = "date"
    return frame


def feature_spec() -> dict[str, dict]:
    """Machine-readable description of each feature, shipped in the artifact."""
    return {
        "ret": {"transform": "log_return", "source": "SP500", "window": 1, "ddof": None, "annualized": False},
        "logVix": {"transform": "log", "source": "VIXCLS", "window": None, "ddof": None, "annualized": False},
        "logRv20": {
            "transform": "log_of_rolling_std_of_ret",
            "source": "SP500",
            "window": RV_WINDOW,
            "ddof": 1,
            "annualized": False,
        },
    }
