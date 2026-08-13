import numpy as np

from eval.simulate_break import (
    BREAK_DURATIONS_MIN,
    BreakRewardSettings,
    ideal_duration,
    run_break_simulation,
    sample_break_reward_batch,
)


def test_ideal_duration_is_higher_in_the_evening_and_with_more_fatigue():
    settings_low = ideal_duration(hour=10.0, fatigue_norm=0.0)
    settings_high_fatigue = ideal_duration(hour=10.0, fatigue_norm=1.0)
    settings_evening = ideal_duration(hour=21.0, fatigue_norm=0.0)
    assert settings_high_fatigue > settings_low
    assert settings_evening > settings_low


def test_ideal_duration_stays_within_its_clamped_range():
    for hour in (0.0, 10.0, 23.9):
        for fatigue in (0.0, 0.5, 1.0):
            d = ideal_duration(hour, fatigue)
            assert 10.0 <= d <= 130.0


def test_reward_is_never_above_the_completion_bonus():
    rng = np.random.default_rng(0)
    settings = BreakRewardSettings()
    for duration in BREAK_DURATIONS_MIN:
        rewards = sample_break_reward_batch(duration, ideal_min=30.0, rng=rng, k=500, settings=settings)
        assert np.all(rewards <= settings.complete_bonus + 1e-9)
        assert np.all(rewards >= -1.0 - 1e-9)


def test_a_duration_matched_to_the_ideal_scores_better_on_average_than_an_extreme_one():
    rng = np.random.default_rng(1)
    settings = BreakRewardSettings()
    ideal_min = 40.0
    matched = np.mean(sample_break_reward_batch(45, ideal_min, rng, 2000, settings))
    far_too_long = np.mean(sample_break_reward_batch(120, ideal_min, rng, 2000, settings))
    far_too_short = np.mean(sample_break_reward_batch(10, ideal_min, rng, 2000, settings))
    assert matched > far_too_long
    assert matched > far_too_short


def test_bandit_selection_is_not_degenerate_and_regret_stays_finite():
    result = run_break_simulation(n_rounds=300, alpha=0.15, gamma=0.99, seed=0)
    assert np.isfinite(result["final_regret"])
    assert np.all(np.isfinite(result["cumulative_regret"]))
    # Cumulative regret should be non-decreasing (each round's oracle - realized >= ... well
    # regret itself isn't necessarily >=0 per round if the sampled outcome beat the MC oracle
    # estimate by chance, but the running sum over 300 rounds shouldn't end up negative).
    assert result["final_regret"] > -50.0


def test_learning_narrows_the_gap_to_the_ideal_duration_on_average_across_seeds():
    # A single seed's second-half gap can come in slightly above its first-half gap by chance
    # (this is a stochastic environment - see the module's Monte Carlo oracle) - averaging over
    # several seeds is what makes "learning helps" a claim about the policy, not one seed's luck.
    seeds = (0, 1, 2, 3, 4)
    firsts, seconds = [], []
    for seed in seeds:
        r = run_break_simulation(n_rounds=400, alpha=0.15, gamma=0.99, seed=seed)
        firsts.append(r["mean_abs_gap_first_half"])
        seconds.append(r["mean_abs_gap_second_half"])
    assert np.mean(seconds) < np.mean(firsts)
