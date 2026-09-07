"""Print today's (or an as-of) regime reading as JSON.

    python -m ml.regime.predict [--as-of YYYY-MM-DD] [--previous <regime>] [--threshold 0.6]

Compare by hand with ``GET /api/market/regime-ml`` on the running server: the
two must agree on ``regime`` and every probability to 1e-6 for the same
``asOf`` and ``previous`` -- that agreement is one of the enabling rules.
"""

from __future__ import annotations

import argparse
import json

from .infer import DEFAULT_MODEL_PATH, get_market_regime


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Read the market regime from the shipped HMM.")
    parser.add_argument("--as-of", default=None, help="last data date to use (YYYY-MM-DD); default: today")
    parser.add_argument("--previous", default=None, help="yesterday's regime, for the sticky switch")
    parser.add_argument("--threshold", type=float, default=None, help="switch threshold (default: the model's)")
    parser.add_argument("--model", default=str(DEFAULT_MODEL_PATH), help="path to regimeModel.json")
    args = parser.parse_args(argv)
    reading = get_market_regime(
        as_of=args.as_of, previous=args.previous, threshold=args.threshold, model_path=args.model
    )
    print(json.dumps(reading.to_dict(), indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
