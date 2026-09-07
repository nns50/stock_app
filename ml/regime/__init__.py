"""The market-regime model: a Gaussian HMM over daily S&P 500 features.

    from ml.regime import get_market_regime
    reading = get_market_regime()          # fetches FRED, reads the shipped artifact
    reading.regime                         # 'high_vol_bearish' | 'low_vol_bullish' | 'sideways'
    reading.label                          # 'High Volatility/Bearish' | ...

See docs/MARKET_REGIME_MODEL.md.
"""

from .infer import DISPLAY_LABELS, LABELS, RegimeReading, get_market_regime

__all__ = ["DISPLAY_LABELS", "LABELS", "RegimeReading", "get_market_regime"]
