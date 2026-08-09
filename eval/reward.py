"""Python port of the context/reward logic in lib/config.js.

Ported (not shared) for the same reason as linucb.py — see that file's
docstring and docs/adr/0001-reward-shaping-and-eval-harness.md. Keep these
constants in sync with lib/config.js by hand; test_reward.py pins the values
that must match so drift fails CI instead of silently diverging.
"""

from __future__ import annotations

import math
from dataclasses import dataclass

import numpy as np

# --- Constants mirrored from lib/config.js -----------------------------------
ARM_DURATIONS_MIN = [0, 5, 15, 30]  # 0 = deny
DEFAULT_ALPHA = 1.0
DEFAULT_DISCOUNT_FACTOR = 0.99
DEFAULT_PENALTY_PER_MINUTE = 1 / 30
DEFAULT_DENY_REWARD = 0.15
DEFAULT_OVERRIDE_SESSION_PENALTY = 0.3
DEFAULT_FREQUENCY_WINDOW_MIN = 30
DEFAULT_FREQUENCY_PENALTY_PER_SESSION = 0.1
DEFAULT_MAX_FREQUENCY_PENALTY = 1.0

# --- New, opt-in "clean grant" bonus ------------------------------------------
# Not in lib/config.js today. This is the variable the eval harness exists to
# test: computeGrantReward() in the live extension caps every grant's reward
# at 0, which means no grant outcome can ever out-score a denial that stands
# (fixed at +0.15). That's not a bug — DEFAULT_DENY_REWARD's docstring in
# lib/config.js is explicit that "access itself is never a positive outcome" —
# but it does mean the bandit cannot, even in principle, learn a context where
# granting is the better call, since the two arms' reward ranges never
# overlap. DEFAULT_CLEAN_GRANT_BONUS lets a grant session that ended almost
# immediately, wasn't an override, and had no recent repeat sessions score a
# small positive reward instead of capping at 0 — closing that gap just
# enough for the mean-reward comparison (not only the UCB exploration bonus)
# to be able to favor granting in a context that's actually low-risk. Default
# is 0 (matches current live behavior exactly) — this is off unless someone
# deliberately turns it on; see the ADR for the simulated comparison.
DEFAULT_CLEAN_GRANT_BONUS = 0.0
CLEAN_GRANT_MAX_ACTIVE_MINUTES = 0.5  # "almost immediately" threshold


@dataclass
class RewardSettings:
    penalty_per_minute: float = DEFAULT_PENALTY_PER_MINUTE
    deny_reward: float = DEFAULT_DENY_REWARD
    override_session_penalty: float = DEFAULT_OVERRIDE_SESSION_PENALTY
    frequency_penalty_per_session: float = DEFAULT_FREQUENCY_PENALTY_PER_SESSION
    max_frequency_penalty: float = DEFAULT_MAX_FREQUENCY_PENALTY
    clean_grant_bonus: float = DEFAULT_CLEAN_GRANT_BONUS


def compute_grant_reward(
    active_minutes: float,
    recent_session_count: int,
    was_override: bool,
    settings: RewardSettings,
) -> float:
    """Direct port of computeGrantReward() in lib/config.js, extended with the
    optional clean-grant bonus described above. With clean_grant_bonus=0.0
    (the default) this returns bit-for-bit what the JS version returns."""
    duration_penalty = active_minutes * settings.penalty_per_minute
    frequency_penalty = min(
        settings.max_frequency_penalty,
        recent_session_count * settings.frequency_penalty_per_session,
    )
    override_penalty = settings.override_session_penalty if was_override else 0.0
    reward = -duration_penalty - frequency_penalty - override_penalty

    is_clean = (
        active_minutes <= CLEAN_GRANT_MAX_ACTIVE_MINUTES
        and recent_session_count == 0
        and not was_override
    )
    if is_clean and settings.clean_grant_bonus > 0:
        reward += settings.clean_grant_bonus

    ceiling = settings.clean_grant_bonus if is_clean else 0.0
    return max(-1.0, min(ceiling, reward))


def compute_grant_reward_batch(
    active_minutes: np.ndarray,
    recent_session_count: int,
    was_override: bool,
    settings: RewardSettings,
) -> np.ndarray:
    """Vectorized form of compute_grant_reward for Monte Carlo estimation over
    many samples at once (eval/simulate.py's oracle calculation). Same
    formula, batched — kept as a separate function rather than branching
    inside compute_grant_reward so the scalar version stays a direct,
    line-for-line port of lib/config.js."""
    duration_penalty = active_minutes * settings.penalty_per_minute
    frequency_penalty = min(
        settings.max_frequency_penalty,
        recent_session_count * settings.frequency_penalty_per_session,
    )
    override_penalty = settings.override_session_penalty if was_override else 0.0
    reward = -duration_penalty - frequency_penalty - override_penalty

    is_clean = (
        (active_minutes <= CLEAN_GRANT_MAX_ACTIVE_MINUTES)
        & (recent_session_count == 0)
        & (not was_override)
    )
    if settings.clean_grant_bonus > 0:
        reward = reward + np.where(is_clean, settings.clean_grant_bonus, 0.0)
    ceiling = np.where(is_clean, settings.clean_grant_bonus, 0.0)
    return np.clip(reward, -1.0, np.maximum(ceiling, 0.0))


def build_context(hour: float, minute: float, day_of_week: int, freq_24h: float, avg_recent_active_min: float) -> list[float]:
    """Direct port of buildContext() in lib/config.js. hour/minute/day_of_week
    describe the decision timestamp; freq_24h and avg_recent_active_min are the
    same recentStats fields the JS version reads."""
    hour_angle = ((hour + minute / 60) / 24) * 2 * math.pi
    dow_angle = (day_of_week / 7) * 2 * math.pi
    freq = min(1.0, freq_24h / 10)
    avg_min = min(1.0, avg_recent_active_min / 60)
    return [
        1.0,
        math.sin(hour_angle),
        math.cos(hour_angle),
        math.sin(dow_angle),
        math.cos(dow_angle),
        freq,
        avg_min,
    ]
