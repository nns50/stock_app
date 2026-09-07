"""Fitting, labeling and exporting the Gaussian HMM.

Three states, full covariance, on the standardized features of
``features.py``. States are unlabeled by the fit; :func:`label_states` names
them from their fitted means with assertions instead of guesses -- a fit whose
states do not separate the way the labels claim raises :class:`LabelingError`
(retrain with another seed) rather than shipping a silently mislabeled model.

"Bearish" is the high-vol state's fitted mean drift. It is not a forecast.
"""

from __future__ import annotations

from typing import Any

import numpy as np
from hmmlearn.hmm import GaussianHMM
from sklearn.preprocessing import StandardScaler

from .data import FRED_CSV_URL
from .features import FEATURES, feature_spec
from .infer import DEFAULT_INFERENCE_WINDOW, DEFAULT_SWITCH_THRESHOLD, LABELS

N_STATES = 3


class LabelingError(ValueError):
    """The fitted states cannot be named by the rule without guessing."""


def fit_hmm(
    x_raw: np.ndarray,
    *,
    seed: int = 7,
    n_iter: int = 500,
    tol: float = 1e-4,
) -> tuple[GaussianHMM, StandardScaler]:
    """StandardScaler + GaussianHMM(3, full) on the raw feature matrix."""
    x_raw = np.asarray(x_raw, dtype=float)
    scaler = StandardScaler().fit(x_raw)
    x_std = scaler.transform(x_raw)
    model = GaussianHMM(
        n_components=N_STATES,
        covariance_type="full",
        n_iter=n_iter,
        tol=tol,
        random_state=seed,
    )
    model.fit(x_std)
    return model, scaler


def raw_means(model: GaussianHMM, scaler: StandardScaler) -> np.ndarray:
    """Fitted state means back on the raw feature scale (K x d)."""
    return scaler.inverse_transform(np.asarray(model.means_))


def label_from_raw_means(means: np.ndarray, feature_names: tuple[str, ...] = FEATURES) -> dict[int, str]:
    """The labeling rule, on raw-scale means. Volatility is the primary axis.

    * order the states by their ``logVix`` mean: highest -> ``high_vol_bearish``,
      lowest -> ``low_vol_bullish``, the middle one -> ``sideways``;
    * the highest-VIX state must also have the highest ``logRv20`` mean, or
      the two volatility readings disagree about which state is stressed;
    * the high-vol state may not drift up faster than the low-vol state --
      "Bearish" and "Bullish" describe the fitted drifts and must not be lies.

    Drift does NOT order the two calm states: right after a crash the fit can
    split them into "calm and rising" and "calmer and rising less", and a rule
    that demanded the bullish one be the calmer one refused a valid fit
    (the 2020-04-01 walk-forward refit). Their drifts are reported, not asserted.
    """
    means = np.asarray(means, dtype=float)
    if means.shape != (N_STATES, len(feature_names)):
        raise LabelingError(f"expected {N_STATES}x{len(feature_names)} means, got {means.shape}")
    i_ret, i_vix, i_rv = (feature_names.index(name) for name in ("ret", "logVix", "logRv20"))
    low, mid, high = (int(k) for k in np.argsort(means[:, i_vix]))
    by_rv = int(np.argmax(means[:, i_rv]))
    if by_rv != high:
        raise LabelingError(
            f"highest logVix mean is state {high} but highest logRv20 mean is state {by_rv}; "
            "the volatility readings disagree about the stressed state"
        )
    if means[high, i_ret] > means[low, i_ret]:
        raise LabelingError(
            f"the high-vol state ({high}) drifts up faster than the low-vol state ({low}); "
            "'bearish' and 'bullish' would be misnomers"
        )
    return {high: "high_vol_bearish", low: "low_vol_bullish", mid: "sideways"}


def label_states(
    model: GaussianHMM, scaler: StandardScaler, feature_names: tuple[str, ...] = FEATURES
) -> dict[int, str]:
    return label_from_raw_means(raw_means(model, scaler), feature_names)


def stationary_distribution(transmat: np.ndarray) -> np.ndarray:
    """The left eigenvector of A for eigenvalue 1, normalized to sum to 1."""
    values, vectors = np.linalg.eig(np.asarray(transmat, dtype=float).T)
    idx = int(np.argmin(np.abs(values - 1.0)))
    vec = np.real(vectors[:, idx])
    vec = vec / vec.sum()
    return vec


def to_export(
    model: GaussianHMM,
    scaler: StandardScaler,
    labels: dict[int, str],
    *,
    version: str,
    training: dict[str, Any],
    drift: dict[str, Any],
    feature_names: tuple[str, ...] = FEATURES,
    inference_window: int = DEFAULT_INFERENCE_WINDOW,
    switch_threshold: float = DEFAULT_SWITCH_THRESHOLD,
) -> dict[str, Any]:
    """The artifact ``server/data/regimeModel.json`` -- everything precomputed.

    ``precision = inv(Sigma_k)`` and ``logDet = ln|Sigma_k|`` are stored so the
    TypeScript side evaluates ``ln N(x)`` with a matrix-vector product and no
    linear algebra of its own. ``covariance`` is kept beside them for humans
    and for the round-trip test (``precision . covariance ~ I``).
    """
    if set(labels.values()) != set(LABELS) or set(labels.keys()) != set(range(model.n_components)):
        raise ValueError(f"labels must map every state to a distinct label: {labels}")
    transmat = np.asarray(model.transmat_, dtype=float)
    raw = raw_means(model, scaler)
    states = []
    for k in range(model.n_components):
        cov = np.asarray(model.covars_[k], dtype=float)
        sign, log_det = np.linalg.slogdet(cov)
        if sign <= 0:
            raise ValueError(f"state {k} covariance is not positive definite")
        states.append(
            {
                "index": k,
                "label": labels[k],
                "mean": np.asarray(model.means_[k], dtype=float).tolist(),
                "covariance": cov.tolist(),
                "precision": np.linalg.inv(cov).tolist(),
                "logDet": float(log_det),
                "rawMean": {name: float(raw[k, i]) for i, name in enumerate(feature_names)},
                "expectedDwellSessions": float(1.0 / max(1e-12, 1.0 - transmat[k, k])),
            }
        )
    return {
        "version": version,
        "modelType": "GaussianHMM",
        "nStates": int(model.n_components),
        "covarianceType": "full",
        "features": list(feature_names),
        "featureSpec": feature_spec(),
        "sources": {
            "SP500": "FRED series SP500 (S&P 500 daily close)",
            "VIXCLS": "FRED series VIXCLS (CBOE VIX daily close)",
            "url": FRED_CSV_URL,
        },
        "scaler": {"mean": np.asarray(scaler.mean_).tolist(), "scale": np.asarray(scaler.scale_).tolist()},
        "startprob": np.asarray(model.startprob_, dtype=float).tolist(),
        "transmat": transmat.tolist(),
        "stationary": stationary_distribution(transmat).tolist(),
        "states": states,
        "inferenceWindow": int(inference_window),
        "switchThresholdDefault": float(switch_threshold),
        "training": training,
        "drift": drift,
    }
