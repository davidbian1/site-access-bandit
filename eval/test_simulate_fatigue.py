import numpy as np

from eval.simulate_fatigue import run_fatigue_simulation


def test_regret_is_finite_with_and_without_the_fatigue_feature():
    for use_feature in (False, True):
        result = run_fatigue_simulation(n_rounds=100, use_fatigue_feature=use_feature, fatigue_coupling=0.3, seed=0)
        assert np.isfinite(result["final_regret"])
        assert np.all(np.isfinite(result["cumulative_regret"]))


def test_zero_coupling_means_the_feature_carries_no_real_signal_either_way():
    # Not a strict equality claim (both runs still explore/update independently and the
    # feature dimension itself changes the model's parameter count) - just checking neither
    # condition blows up or produces wildly different regret when the ground truth genuinely
    # doesn't depend on fatigue at all.
    without = run_fatigue_simulation(n_rounds=200, use_fatigue_feature=False, fatigue_coupling=0.0, seed=0)["final_regret"]
    with_feature = run_fatigue_simulation(n_rounds=200, use_fatigue_feature=True, fatigue_coupling=0.0, seed=0)["final_regret"]
    assert abs(without - with_feature) < 0.5 * max(abs(without), abs(with_feature), 1.0)
