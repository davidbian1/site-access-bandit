import math

from eval.reward import (
    DEFAULT_DENY_REWARD,
    RewardSettings,
    build_context,
    compute_grant_reward,
)


def test_grant_reward_never_exceeds_zero_by_default():
    """Pins the current, live lib/config.js behavior: with clean_grant_bonus
    at its default (0), no grant can score above 0 — matching computeGrantReward's
    Math.max(-1, Math.min(0, reward)) clamp exactly. If lib/config.js changes
    this clamp, this test should be revisited alongside it."""
    settings = RewardSettings()
    for active_minutes in (0, 1, 5, 30, 100):
        for count in (0, 1, 5):
            for override in (False, True):
                reward = compute_grant_reward(active_minutes, count, override, settings)
                assert reward <= 0.0


def test_grant_reward_floor_is_minus_one():
    settings = RewardSettings()
    reward = compute_grant_reward(active_minutes=1000, recent_session_count=100, was_override=True, settings=settings)
    assert reward == -1.0


def test_deny_reward_exceeds_best_possible_grant_by_default():
    """This is the exact structural gap the eval harness exists to
    demonstrate: with clean_grant_bonus=0, DEFAULT_DENY_REWARD (a fixed,
    context-independent 0.15) is strictly greater than the best reward any
    grant can ever achieve (0). No amount of context or data can make LinUCB
    prefer a grant on mean reward alone under these defaults."""
    settings = RewardSettings()
    best_possible_grant = compute_grant_reward(active_minutes=0, recent_session_count=0, was_override=False, settings=settings)
    assert best_possible_grant == 0.0
    assert DEFAULT_DENY_REWARD > best_possible_grant


def test_clean_grant_bonus_lets_a_brief_grant_beat_deny():
    """With the bonus enabled, a near-instant, non-repeat, non-override grant
    can score above deny's fixed reward — the opt-in fix. Off by default."""
    settings = RewardSettings(clean_grant_bonus=0.2)
    reward = compute_grant_reward(active_minutes=0.1, recent_session_count=0, was_override=False, settings=settings)
    assert reward > DEFAULT_DENY_REWARD


def test_clean_grant_bonus_does_not_apply_to_a_long_or_repeat_session():
    settings = RewardSettings(clean_grant_bonus=0.2)
    long_session = compute_grant_reward(active_minutes=20, recent_session_count=0, was_override=False, settings=settings)
    repeat_session = compute_grant_reward(active_minutes=0.1, recent_session_count=2, was_override=False, settings=settings)
    assert long_session <= 0.0
    assert repeat_session <= 0.0


def test_build_context_matches_feature_dim_and_bias_term():
    ctx = build_context(hour=12, minute=0, day_of_week=3, freq_24h=2, avg_recent_active_min=10)
    assert len(ctx) == 7
    assert ctx[0] == 1.0


def test_build_context_hour_angle_wraps_correctly():
    """Hour 0 and hour 24 (via minute overflow isn't valid input, so use hour
    23:59 vs hour 0:00) should be close in sin/cos space — the whole point of
    the cyclical encoding is that 23:59 and 00:01 are adjacent, not far apart
    like raw hour-of-day integers would be."""
    late = build_context(hour=23, minute=59, day_of_week=0, freq_24h=0, avg_recent_active_min=0)
    early = build_context(hour=0, minute=1, day_of_week=0, freq_24h=0, avg_recent_active_min=0)
    dist = math.dist(late[1:3], early[1:3])
    assert dist < 0.1
