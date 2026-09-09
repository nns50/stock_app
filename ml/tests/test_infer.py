import math

import numpy as np
import pandas as pd
import pytest

from ml.regime.infer import (
    UNKNOWN,
    RegimeParams,
    classify,
    drift_score,
    forward_filter,
    from_export,
    log_gaussian,
    logsumexp,
    predicted_next,
    standardize,
    sticky_switch,
)
from ml.regime.model import to_export


def toy_params() -> RegimeParams:
    """The hand-computed two-state toy from the plan: mu 0 / 2, unit variance."""
    return RegimeParams(
        version="toy",
        features=("x",),
        scaler_mean=np.array([0.0]),
        scaler_scale=np.array([1.0]),
        startprob=np.array([0.5, 0.5]),
        transmat=np.array([[0.9, 0.1], [0.2, 0.8]]),
        means=np.array([[0.0], [2.0]]),
        precisions=np.array([[[1.0]], [[1.0]]]),
        log_dets=np.array([0.0, 0.0]),
        labels=("low_vol_bullish", "high_vol_bearish"),
    )


def test_logsumexp_edge_cases():
    assert logsumexp(np.array([-np.inf, -np.inf])) == -np.inf
    assert np.isclose(logsumexp(np.array([0.0, -np.inf])), 0.0)
    assert np.isclose(logsumexp(np.array([1000.0, 1000.0])), 1000.0 + math.log(2))


def test_log_gaussian_matches_closed_form():
    assert np.isclose(log_gaussian(np.array([0.0]), np.array([0.0]), np.array([[1.0]]), 0.0), -0.5 * math.log(2 * math.pi))
    cov = np.array([[2.0, 0.3], [0.3, 1.0]])
    x, mu = np.array([0.4, -0.2]), np.array([0.1, 0.1])
    expected = -0.5 * (2 * math.log(2 * math.pi) + np.linalg.slogdet(cov)[1] + (x - mu) @ np.linalg.inv(cov) @ (x - mu))
    assert np.isclose(log_gaussian(x, mu, np.linalg.inv(cov), np.linalg.slogdet(cov)[1]), expected)


def test_hand_computed_toy_filter():
    post, loglik, ct = forward_filter(toy_params(), np.array([[0.0], [2.0]]))
    assert np.allclose(post[0], [0.880797, 0.119203], atol=1e-6)
    assert np.allclose(post[1], [0.375944, 0.624056], atol=1e-6)
    assert np.isclose(loglik, -3.6284, atol=1e-4)
    assert np.isclose(ct.sum(), loglik)
    assert np.allclose(predicted_next(post[1], toy_params().transmat), [0.463161, 0.536839], atol=1e-6)


def test_forward_filter_agrees_with_hmmlearn(fitted, synthetic_features):
    model, scaler, labels = fitted
    export = to_export(model, scaler, labels, version="test", training={}, drift={"window": 10})
    params = from_export(export)
    x_std = standardize(synthetic_features.to_numpy(dtype=float)[-120:], params)
    post, loglik, _ = forward_filter(params, x_std)
    assert np.isclose(loglik, model.score(x_std), atol=1e-9)
    assert np.allclose(post[-1], model.predict_proba(x_std)[-1], atol=1e-9)
    assert np.allclose(post.sum(axis=1), 1.0)


def test_standardize_matches_the_scaler(fitted, synthetic_features):
    model, scaler, labels = fitted
    params = from_export(to_export(model, scaler, labels, version="t", training={}, drift={"window": 10}))
    x = synthetic_features.to_numpy(dtype=float)[:5]
    assert np.allclose(standardize(x, params), scaler.transform(x))


@pytest.mark.parametrize(
    "previous,posterior,expected",
    [
        (None, [0.2, 0.7, 0.1], ("low_vol_bullish", "low_vol_bullish", False, False)),  # no previous: accept
        (UNKNOWN, [0.2, 0.7, 0.1], ("low_vol_bullish", "low_vol_bullish", False, False)),  # unknown: accept
        ("low_vol_bullish", [0.3, 0.55, 0.15], ("low_vol_bullish", "low_vol_bullish", False, False)),  # same: hold
        ("sideways", [0.7, 0.2, 0.1], ("high_vol_bearish", "high_vol_bearish", True, False)),  # >= thr: switch
        ("sideways", [0.55, 0.3, 0.15], ("sideways", "high_vol_bearish", False, True)),  # < thr: held
    ],
)
def test_sticky_switch_cases(previous, posterior, expected):
    labels = ("high_vol_bearish", "low_vol_bullish", "sideways")
    assert sticky_switch(previous, np.array(posterior), labels, 0.6) == expected


def test_drift_score_is_the_trailing_mean_or_nan():
    assert np.isclose(drift_score(np.arange(20.0), 10), np.mean(np.arange(10.0, 20.0)))
    assert math.isnan(drift_score(np.arange(5.0), 10))


def test_classify_flags_drift_without_changing_the_regime(fitted, synthetic_features):
    model, scaler, labels = fitted
    drifting = from_export(to_export(model, scaler, labels, version="t", training={}, drift={"window": 10, "p5": 1e9}))
    reading = classify(drifting, synthetic_features, previous=None)
    assert reading.drift is True
    assert reading.regime == reading.candidate != UNKNOWN
    assert np.isclose(sum(reading.probabilities.values()), 1.0)
    calm = from_export(to_export(model, scaler, labels, version="t", training={}, drift={"window": 10, "p5": -1e9}))
    calm_reading = classify(calm, synthetic_features, previous=None)
    assert calm_reading.drift is False and calm_reading.regime == reading.regime


def test_classify_refuses_a_short_window(fitted, synthetic_features):
    model, scaler, labels = fitted
    params = from_export(to_export(model, scaler, labels, version="t", training={}, drift={"window": 10}))
    with pytest.raises(ValueError, match="at least"):
        classify(params, synthetic_features.iloc[:30])
