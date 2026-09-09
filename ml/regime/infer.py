"""Pure-numpy inference: THE reference the TypeScript port must equal.

Nothing here imports hmmlearn or scikit-learn. ``train.py`` proves this
forward filter agrees with hmmlearn (``score()`` for the log-likelihood,
``predict_proba()[-1]`` for the last filtered posterior -- ``predict_proba`` is
forward-backward SMOOTHED, so only its last row is a filtered value) and writes
a fixture; the Vitest parity test proves the TypeScript port agrees with the
fixture. Change the math in one place and both checks fail, which is the point.

The filter is the scaled forward algorithm in log space::

    logAlpha[k] = ln pi[k] + logB[0][k];  c0 = logsumexp(logAlpha)
    post[0]     = exp(logAlpha - c0);      logL = c0
    for t >= 1:
        logPred[j] = logsumexp_i( ln post[t-1][i] + ln A[i][j] )
        logAlpha[j] = logPred[j] + logB[t][j]
        ct = logsumexp(logAlpha);  post[t] = exp(logAlpha - ct);  logL += ct
    predictedNext = post[T-1] @ A

``ct`` is ln p(x_t | x_1..t-1); their sum is the log-likelihood hmmlearn's
``score`` reports, and the trailing mean of the last ``drift_window`` of them
is the drift statistic the runtime compares against the training 5th
percentile.
"""

from __future__ import annotations

import json
import math
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import numpy as np
import pandas as pd

from .features import FEATURES, build_features

LABELS: tuple[str, ...] = ("high_vol_bearish", "low_vol_bullish", "sideways")
UNKNOWN = "unknown"
DISPLAY_LABELS: dict[str, str] = {
    "high_vol_bearish": "High Volatility/Bearish",
    "low_vol_bullish": "Low Volatility/Bullish",
    "sideways": "Sideways",
    UNKNOWN: "Unknown",
}
DEFAULT_MODEL_PATH = Path(__file__).resolve().parents[2] / "server" / "data" / "regimeModel.json"
DEFAULT_INFERENCE_WINDOW = 250
DEFAULT_SWITCH_THRESHOLD = 0.6
DRIFT_WINDOW = 10
# Fewer feature rows than this and the filter has not settled from its prior:
# the runtime reads `unknown` rather than a guess.
MIN_INFERENCE_ROWS = 60
# Calendar days of history the runtime fetches to be sure of 250 feature rows
# (~1.45 calendar days per session, plus the 20-row warmup and holidays).
LOOKBACK_CALENDAR_DAYS = 500


class ModelError(ValueError):
    """The exported artifact is not a usable model."""


@dataclass
class RegimeParams:
    """Everything inference needs, precomputed so no linear algebra runs at read time."""

    version: str
    features: tuple[str, ...]
    scaler_mean: np.ndarray
    scaler_scale: np.ndarray
    startprob: np.ndarray
    transmat: np.ndarray
    means: np.ndarray
    precisions: np.ndarray
    log_dets: np.ndarray
    labels: tuple[str, ...]
    inference_window: int = DEFAULT_INFERENCE_WINDOW
    switch_threshold: float = DEFAULT_SWITCH_THRESHOLD
    drift_window: int = DRIFT_WINDOW
    drift_p5: float | None = None
    raw: dict[str, Any] = field(default_factory=dict, repr=False)

    @property
    def n_states(self) -> int:
        return len(self.labels)

    def state_of(self, label: str) -> int:
        return self.labels.index(label)


def from_export(exported: dict[str, Any]) -> RegimeParams:
    """Read the artifact back, validating what the TypeScript zod schema validates."""
    try:
        features = tuple(exported["features"])
        states = sorted(exported["states"], key=lambda s: s["index"])
        labels = tuple(s["label"] for s in states)
        means = np.array([s["mean"] for s in states], dtype=float)
        precisions = np.array([s["precision"] for s in states], dtype=float)
        log_dets = np.array([s["logDet"] for s in states], dtype=float)
        transmat = np.array(exported["transmat"], dtype=float)
        startprob = np.array(exported["startprob"], dtype=float)
        scaler_mean = np.array(exported["scaler"]["mean"], dtype=float)
        scaler_scale = np.array(exported["scaler"]["scale"], dtype=float)
        version = str(exported["version"])
    except (KeyError, TypeError, ValueError) as exc:
        raise ModelError(f"artifact missing or malformed field: {exc!r}") from exc
    k, d = len(states), len(features)
    if [s["index"] for s in states] != list(range(k)):
        raise ModelError("state indices must be 0..K-1")
    if len(set(labels)) != k or not set(labels) <= set(LABELS):
        raise ModelError(f"labels must be distinct and drawn from {LABELS}: {labels}")
    if means.shape != (k, d) or precisions.shape != (k, d, d) or log_dets.shape != (k,):
        raise ModelError("state parameter shapes disagree with features/states")
    if transmat.shape != (k, k) or startprob.shape != (k,):
        raise ModelError("transmat/startprob shapes disagree with the state count")
    if not np.allclose(transmat.sum(axis=1), 1.0, atol=1e-6) or not math.isclose(startprob.sum(), 1.0, abs_tol=1e-6):
        raise ModelError("transmat rows and startprob must each sum to 1")
    if np.any(transmat < 0) or np.any(startprob < 0):
        raise ModelError("probabilities must be non-negative")
    for p in precisions:
        if not np.allclose(p, p.T, atol=1e-8):
            raise ModelError("precision matrices must be symmetric")
    if scaler_mean.shape != (d,) or scaler_scale.shape != (d,) or np.any(scaler_scale <= 0):
        raise ModelError("scaler must carry one positive scale per feature")
    drift = exported.get("drift") or {}
    return RegimeParams(
        version=version,
        features=features,
        scaler_mean=scaler_mean,
        scaler_scale=scaler_scale,
        startprob=startprob,
        transmat=transmat,
        means=means,
        precisions=precisions,
        log_dets=log_dets,
        labels=labels,
        inference_window=int(exported.get("inferenceWindow", DEFAULT_INFERENCE_WINDOW)),
        switch_threshold=float(exported.get("switchThresholdDefault", DEFAULT_SWITCH_THRESHOLD)),
        drift_window=int(drift.get("window", DRIFT_WINDOW)),
        drift_p5=None if drift.get("p5") is None else float(drift["p5"]),
        raw=exported,
    )


def load_params(path: str | Path = DEFAULT_MODEL_PATH) -> RegimeParams:
    return from_export(json.loads(Path(path).read_text()))


# --- the math ---------------------------------------------------------------


def standardize(x_raw: np.ndarray, params: RegimeParams) -> np.ndarray:
    return (np.asarray(x_raw, dtype=float) - params.scaler_mean) / params.scaler_scale


def logsumexp(values: np.ndarray) -> float:
    values = np.asarray(values, dtype=float)
    top = float(np.max(values))
    if not np.isfinite(top):
        return top  # all -inf (or an inf/nan, which propagates)
    return top + float(np.log(np.sum(np.exp(values - top))))


def log_gaussian(x: np.ndarray, mean: np.ndarray, precision: np.ndarray, log_det: float) -> float:
    """ln N(x; mean, P^-1) = -0.5 * (d ln 2pi + ln|Sigma| + (x-mean)^T P (x-mean))."""
    diff = np.asarray(x, dtype=float) - mean
    maha = float(diff @ precision @ diff)
    return -0.5 * (len(diff) * math.log(2 * math.pi) + log_det + maha)


def log_emissions(params: RegimeParams, x_std: np.ndarray) -> np.ndarray:
    x_std = np.asarray(x_std, dtype=float)
    out = np.empty((x_std.shape[0], params.n_states))
    for k in range(params.n_states):
        for t in range(x_std.shape[0]):
            out[t, k] = log_gaussian(x_std[t], params.means[k], params.precisions[k], float(params.log_dets[k]))
    return out


def forward_filter(params: RegimeParams, x_std: np.ndarray) -> tuple[np.ndarray, float, np.ndarray]:
    """Filtered posteriors (T x K), total log-likelihood, per-step log-likelihoods (T)."""
    log_b = log_emissions(params, x_std)
    n_obs, n_states = log_b.shape
    if n_obs == 0:
        raise ValueError("forward_filter needs at least one observation")
    post = np.zeros((n_obs, n_states))
    ct = np.zeros(n_obs)
    with np.errstate(divide="ignore"):
        log_pi = np.log(params.startprob)
        log_a = np.log(params.transmat)
    log_alpha = log_pi + log_b[0]
    c = logsumexp(log_alpha)
    post[0] = np.exp(log_alpha - c)
    ct[0] = c
    for t in range(1, n_obs):
        with np.errstate(divide="ignore"):
            log_prev = np.log(post[t - 1])
        log_pred = np.array([logsumexp(log_prev + log_a[:, j]) for j in range(n_states)])
        log_alpha = log_pred + log_b[t]
        c = logsumexp(log_alpha)
        post[t] = np.exp(log_alpha - c)
        ct[t] = c
    return post, float(ct.sum()), ct


def predicted_next(posterior: np.ndarray, transmat: np.ndarray) -> np.ndarray:
    return np.asarray(posterior, dtype=float) @ np.asarray(transmat, dtype=float)


def drift_score(ct: np.ndarray, window: int = DRIFT_WINDOW) -> float:
    """Mean per-step log-likelihood over the last ``window`` steps (nan if fewer)."""
    ct = np.asarray(ct, dtype=float)
    if len(ct) < window:
        return float("nan")
    return float(np.mean(ct[-window:]))


def sticky_switch(
    previous: str | None,
    posterior: np.ndarray,
    labels: tuple[str, ...],
    threshold: float,
) -> tuple[str, str, bool, bool]:
    """(regime, candidate, switched, held_below_threshold).

    No previous (or an unknown one) -> accept the argmax. Same as previous ->
    hold. Otherwise switch only when the argmax posterior clears ``threshold``;
    below it the previous regime is held and ``held_below_threshold`` says so.
    """
    posterior = np.asarray(posterior, dtype=float)
    best = int(np.argmax(posterior))
    candidate = labels[best]
    if previous is None or previous == UNKNOWN or previous not in labels:
        return candidate, candidate, False, False
    if candidate == previous:
        return previous, candidate, False, False
    if posterior[best] >= threshold:
        return candidate, candidate, True, False
    return previous, candidate, False, True


# --- the reading ------------------------------------------------------------


@dataclass
class RegimeReading:
    regime: str
    label: str
    candidate: str
    probabilities: dict[str, float]
    predicted_next: dict[str, float]
    as_of: str
    features: dict[str, float]
    threshold: float
    switched: bool
    held_below_threshold: bool
    drift: bool
    drift_score: float | None
    drift_p5: float | None
    log_likelihood: float
    rows: int
    model_version: str
    previous: str | None

    def to_dict(self) -> dict[str, Any]:
        return {
            "regime": self.regime,
            "label": self.label,
            "candidate": self.candidate,
            "probabilities": self.probabilities,
            "predictedNext": self.predicted_next,
            "asOf": self.as_of,
            "features": self.features,
            "threshold": self.threshold,
            "switched": self.switched,
            "heldBelowThreshold": self.held_below_threshold,
            "drift": self.drift,
            "driftScore": self.drift_score,
            "driftP5": self.drift_p5,
            "logLikelihood": self.log_likelihood,
            "rows": self.rows,
            "modelVersion": self.model_version,
            "previous": self.previous,
        }


def classify(
    params: RegimeParams,
    window: pd.DataFrame,
    *,
    previous: str | None = None,
    threshold: float | None = None,
) -> RegimeReading:
    """Classify the LAST row of ``window`` (a feature frame, already truncated).

    The frame is trimmed to the model's inference window, standardized and
    forward-filtered from the prior -- exactly what the runtime does each day.
    A drift reading (trailing likelihood below the training 5th percentile)
    is reported in ``drift`` as a retrain signal; the regime is unchanged.
    """
    if len(window) < MIN_INFERENCE_ROWS:
        raise ValueError(f"need at least {MIN_INFERENCE_ROWS} feature rows, got {len(window)}")
    thr = params.switch_threshold if threshold is None else float(threshold)
    window = window.iloc[-params.inference_window :]
    x_std = standardize(window[list(params.features)].to_numpy(dtype=float), params)
    post, loglik, ct = forward_filter(params, x_std)
    last = post[-1]
    nxt = predicted_next(last, params.transmat)
    regime, candidate, switched, held = sticky_switch(previous, last, params.labels, thr)
    score = drift_score(ct, params.drift_window)
    # Drift is FLAGGED, never acted on here. The first walk-forward evaluation
    # (2026-09-07) had it turn the regime `unknown`, and the flag fired on 92%
    # of COVID-crash sessions -- the overlay would have failed open in the one
    # episode it exists for. An observation far from every state in the
    # high-vol direction is still nearest the high-vol state, so the label under
    # drift is directionally right; what drift means is "the probabilities are
    # no longer calibrated -- retrain", and that is what the gauge says.
    drifting = params.drift_p5 is not None and not math.isnan(score) and score < params.drift_p5
    as_of = window.index[-1]
    as_of_str = as_of.date().isoformat() if hasattr(as_of, "date") else str(as_of)
    return RegimeReading(
        regime=regime,
        label=DISPLAY_LABELS[regime],
        candidate=candidate,
        probabilities={lab: float(last[i]) for i, lab in enumerate(params.labels)},
        predicted_next={lab: float(nxt[i]) for i, lab in enumerate(params.labels)},
        as_of=as_of_str,
        features={name: float(window.iloc[-1][name]) for name in params.features},
        threshold=thr,
        switched=switched,
        held_below_threshold=held,
        drift=bool(drifting),
        drift_score=None if math.isnan(score) else score,
        drift_p5=params.drift_p5,
        log_likelihood=loglik,
        rows=len(window),
        model_version=params.version,
        previous=previous,
    )


def get_market_regime(
    params: RegimeParams | None = None,
    *,
    as_of: str | None = None,
    previous: str | None = None,
    threshold: float | None = None,
    sp500: pd.Series | None = None,
    vix: pd.Series | None = None,
    model_path: str | Path = DEFAULT_MODEL_PATH,
) -> RegimeReading:
    """The utility the request asked for: what regime is the market in?

    Outputs one of ``high_vol_bearish`` (High Volatility/Bearish),
    ``low_vol_bullish`` (Low Volatility/Bullish) or ``sideways``, with a
    ``drift`` flag when the model no longer describes the tape (retrain). With
    no series given it fetches FRED itself; pass
    ``previous`` (yesterday's regime) to get the sticky-switch behaviour the
    runtime applies. "Bearish" names the state's fitted mean drift, not a
    forecast of direction.
    """
    if params is None:
        params = load_params(model_path)
    if sp500 is None or vix is None:
        from .data import load_series  # local import: keeps this module network-free by default

        end = pd.Timestamp(as_of) if as_of else pd.Timestamp.today().normalize()
        start = (end - pd.Timedelta(days=LOOKBACK_CALENDAR_DAYS)).date().isoformat()
        sp500, vix = load_series(start, end=end.date().isoformat())
    elif as_of is not None:
        end = pd.Timestamp(as_of)
        sp500 = sp500[sp500.index <= end]
        vix = vix[vix.index <= end]
    feats = build_features(sp500, vix)
    return classify(params, feats, previous=previous, threshold=threshold)


__all__ = [
    "DEFAULT_MODEL_PATH",
    "DISPLAY_LABELS",
    "FEATURES",
    "LABELS",
    "UNKNOWN",
    "ModelError",
    "RegimeParams",
    "RegimeReading",
    "classify",
    "drift_score",
    "forward_filter",
    "from_export",
    "get_market_regime",
    "load_params",
    "log_emissions",
    "log_gaussian",
    "logsumexp",
    "predicted_next",
    "standardize",
    "sticky_switch",
]
