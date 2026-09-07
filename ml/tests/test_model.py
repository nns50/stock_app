import numpy as np
import pytest

from ml.regime.infer import LABELS, from_export
from ml.regime.model import LabelingError, label_from_raw_means, stationary_distribution, to_export

# columns: ret, logVix, logRv20
CALM_BULL = [0.0008, np.log(13.0), np.log(0.006)]
CHOP = [0.0000, np.log(19.0), np.log(0.010)]
STRESS = [-0.0015, np.log(34.0), np.log(0.022)]


def test_labeling_rule_names_all_three():
    labels = label_from_raw_means(np.array([CHOP, STRESS, CALM_BULL]))
    assert labels == {0: "sideways", 1: "high_vol_bearish", 2: "low_vol_bullish"}


def test_labeling_refuses_when_vix_and_rv_disagree_about_the_stressed_state():
    means = np.array([CALM_BULL, [0.0, np.log(34.0), np.log(0.010)], [-0.001, np.log(19.0), np.log(0.022)]])
    with pytest.raises(LabelingError, match="disagree"):
        label_from_raw_means(means)


def test_labeling_orders_the_calm_states_by_volatility_not_drift():
    # The calmer state drifts LESS here; it is still the "low vol / bullish"
    # one, because volatility is the axis and the drifts are only reported.
    calmer_slower = [0.0002, np.log(13.0), np.log(0.006)]
    choppier_faster = [0.0009, np.log(19.0), np.log(0.010)]
    labels = label_from_raw_means(np.array([choppier_faster, calmer_slower, STRESS]))
    assert labels == {0: "sideways", 1: "low_vol_bullish", 2: "high_vol_bearish"}


def test_labeling_refuses_a_high_vol_state_that_drifts_up_fastest():
    means = np.array([CALM_BULL, CHOP, [0.0020, np.log(34.0), np.log(0.022)]])
    with pytest.raises(LabelingError, match="drifts up faster"):
        label_from_raw_means(means)


def test_synthetic_fit_labels_and_exports_round_trip(fitted):
    model, scaler, labels = fitted
    assert set(labels.values()) == set(LABELS)
    export = to_export(model, scaler, labels, version="test", training={}, drift={"window": 10})
    params = from_export(export)
    assert params.labels == tuple(labels[k] for k in range(3))
    for k in range(3):
        cov = np.array(export["states"][k]["covariance"])
        prec = np.array(export["states"][k]["precision"])
        assert np.allclose(prec @ cov, np.eye(3), atol=1e-8)
        assert np.isclose(export["states"][k]["logDet"], np.linalg.slogdet(cov)[1])
    assert np.allclose(np.array(export["transmat"]).sum(axis=1), 1.0)
    assert np.isclose(sum(export["stationary"]), 1.0)


def test_stationary_distribution_is_a_fixed_point():
    a = np.array([[0.9, 0.1, 0.0], [0.05, 0.9, 0.05], [0.0, 0.2, 0.8]])
    pi = stationary_distribution(a)
    assert np.allclose(pi @ a, pi)
    assert np.isclose(pi.sum(), 1.0)
