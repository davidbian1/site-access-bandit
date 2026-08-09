import numpy as np

from eval.linucb import LinUCB, LinUCBArm


def test_arm_starts_at_identity_and_zero():
    arm = LinUCBArm(d=3)
    assert np.allclose(arm.A, np.eye(3))
    assert np.allclose(arm.b, np.zeros(3))


def test_score_with_no_data_is_zero_mean():
    arm = LinUCBArm(d=3)
    x = np.array([1.0, 0.0, 0.0])
    ucb, mean, variance = arm.score(x, alpha=1.0)
    assert mean == 0.0
    assert variance > 0.0
    assert ucb == mean + variance


def test_update_moves_theta_toward_observed_reward():
    """With enough repeated observations of the same context and reward, the
    arm's learned mean prediction for that context should converge close to
    the true reward — the basic sanity check that ridge regression here is
    actually fitting, not just accumulating state."""
    arm = LinUCBArm(d=2)
    x = np.array([1.0, 0.5])
    true_reward = 0.3
    for _ in range(500):
        arm.update(x, true_reward, gamma=1.0)
    _, mean, _ = arm.score(x, alpha=0.0)
    assert abs(mean - true_reward) < 0.05


def test_discount_bounds_matrix_away_from_singular():
    """gamma < 1 re-adds (1-gamma)*I every update, so A should stay
    invertible (condition number bounded) no matter how many updates run —
    this is the numerical-integrity property lib/linucb.js's update() docstring
    calls out explicitly."""
    arm = LinUCBArm(d=4)
    rng = np.random.default_rng(0)
    for _ in range(2000):
        x = rng.normal(size=4)
        arm.update(x, reward=rng.normal(), gamma=0.9)
    cond = np.linalg.cond(arm.A)
    assert np.isfinite(cond)
    assert cond < 1e6


def test_select_arm_prefers_higher_known_mean():
    bandit = LinUCB(n_arms=2, d=1, alpha=0.0, rng=np.random.default_rng(0))
    x = np.array([1.0])
    for _ in range(200):
        bandit.update(0, x, reward=-0.5)
        bandit.update(1, x, reward=0.5)
    arm_index, _ = bandit.select_arm(x)
    assert arm_index == 1


def test_select_arm_breaks_ties_across_untried_arms():
    """With alpha=0 and no data, all arms score identically (mean=0). Over
    many draws, an untried arm shouldn't be starved by always resolving ties
    to index 0 — this is what the random tie-break in select_arm exists for."""
    bandit = LinUCB(n_arms=3, d=1, alpha=0.0, rng=np.random.default_rng(0))
    x = np.array([1.0])
    counts = {0: 0, 1: 0, 2: 0}
    for _ in range(300):
        idx, _ = bandit.select_arm(x)
        counts[idx] += 1
    assert all(c > 0 for c in counts.values())
