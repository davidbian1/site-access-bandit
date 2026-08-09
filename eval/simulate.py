"""A synthetic environment for evaluating the bandit offline, without needing
weeks of real personal usage data.

Honest scope note: this is a simplified, illustrative model of one restricted
site, not a validated model of real user behavior. It exists to answer one
narrow question with real numbers instead of intuition: does the reward
ceiling described in reward.py (grants capped at 0, denials fixed at +0.15)
actually prevent the bandit from learning to grant in genuinely low-risk
contexts? See docs/adr/0001-reward-shaping-and-eval-harness.md for the
finding this produced.

Model:
- A single "risk" function maps context (hour, recent session frequency,
  recent average active time) to a probability in [0, 1] that a granted
  session turns into compulsive, near-full-duration use rather than a brief
  check. Risk is higher late at night and rises with recent usage — the same
  qualitative story lib/config.js's comments already tell about frequency and
  duration penalties.
- Given risk, active_minutes for a grant is drawn from a two-component
  mixture: "checked and left" (near-zero) vs. "used most of the grant."
- Regret per round is computed against a Monte Carlo-estimated oracle: the
  best *expected* reward across all four arms at that round's true risk
  level, compared against the reward actually realized by the arm the bandit
  chose. The bandit itself never observes risk directly — only the same
  context vector and realized reward the real extension would give it.
"""

from __future__ import annotations

from dataclasses import dataclass, field

import numpy as np

from eval.linucb import LinUCB
from eval.reward import (
    DEFAULT_DENY_REWARD,
    DEFAULT_DISCOUNT_FACTOR,
    DEFAULT_FREQUENCY_WINDOW_MIN,
    RewardSettings,
    build_context,
    compute_grant_reward,
    compute_grant_reward_batch,
)

ARM_DURATIONS_MIN = [0, 5, 15, 30]  # index 0 = deny
N_ARMS = len(ARM_DURATIONS_MIN)
MC_SAMPLES = 200


def risk_for(hour: float, recent_session_count: int, avg_recent_active_min: float) -> float:
    """Deterministic ground-truth risk in [0, 1]. Not observed by the bandit."""
    night = 1.0 if (hour >= 22 or hour < 2) else (0.4 if (hour >= 20 or hour < 6) else 0.0)
    frequency_signal = min(1.0, recent_session_count / 4)
    usage_signal = min(1.0, avg_recent_active_min / 20)
    risk = 0.05 + 0.35 * night + 0.35 * frequency_signal + 0.25 * usage_signal
    return float(min(1.0, risk))


def sample_active_minutes(duration_min: int, risk: float, rng: np.random.Generator) -> float:
    if duration_min == 0:
        return 0.0
    if rng.random() < risk:
        return float(rng.uniform(0.6 * duration_min, duration_min))
    return float(rng.uniform(0.0, 0.5))


def _sample_active_minutes_batch(duration_min: int, risk: float, rng: np.random.Generator, k: int) -> np.ndarray:
    if duration_min == 0:
        return np.zeros(k)
    is_compulsive = rng.random(k) < risk
    clean = rng.uniform(0.0, 0.5, k)
    compulsive = rng.uniform(0.6 * duration_min, duration_min, k)
    return np.where(is_compulsive, compulsive, clean)


def expected_reward_mc(duration_min: int, risk: float, recent_session_count: int, settings: RewardSettings, rng: np.random.Generator, k: int = MC_SAMPLES) -> float:
    """Vectorized Monte Carlo estimate of E[reward] for one arm at a given
    risk level — batches all k draws through NumPy instead of a Python-level
    loop, which is what makes a 40-trial Optuna sweep over multiple seeds
    tractable (see eval/tune.py)."""
    if duration_min == 0:
        return settings.deny_reward
    samples = _sample_active_minutes_batch(duration_min, risk, rng, k)
    rewards = compute_grant_reward_batch(samples, recent_session_count, False, settings)
    return float(np.mean(rewards))


@dataclass
class SiteHistory:
    """Rolling per-site session log, mirroring what recentStatsFor() in
    lib/background-helpers.js derives from real session logs."""

    # (timestamp_min, active_minutes, was_grant) - was_grant matters because
    # recentStatsFor()'s sessionsInFrequencyWindow only counts sessions where
    # decision === 'grant'; denials don't count toward frequency there, and
    # recent_count() below needs to filter the same way to stay faithful to
    # the real reward function it's feeding.
    sessions: list[tuple[float, float, bool]] = field(default_factory=list)

    def record(self, t: float, active_minutes: float, was_grant: bool) -> None:
        self.sessions.append((t, active_minutes, was_grant))

    def recent_count(self, t: float, window_min: float) -> int:
        return sum(1 for ts, _, was_grant in self.sessions if was_grant and t - ts <= window_min)

    def avg_recent_active(self, t: float, n: int = 5) -> float:
        # Unlike recent_count, real avgRecentActiveMin is computed over the
        # last 5 sessions regardless of decision (a denial contributes 0
        # active minutes rather than being excluded) - mirrored as-is here.
        recent = [m for _, m, _ in self.sessions[-n:]]
        return float(np.mean(recent)) if recent else 0.0

    def sessions_last_24h(self, t: float) -> int:
        # Also unfiltered by decision in the real sessionsLast24h - mirrored as-is.
        return sum(1 for ts, _, _ in self.sessions if t - ts <= 24 * 60)


def run_simulation(
    n_rounds: int = 500,
    alpha: float = 1.0,
    gamma: float = DEFAULT_DISCOUNT_FACTOR,
    clean_grant_bonus: float = 0.0,
    seed: int = 0,
    mean_gap_min: float = 180.0,
) -> dict:
    rng = np.random.default_rng(seed)
    settings = RewardSettings(deny_reward=DEFAULT_DENY_REWARD, clean_grant_bonus=clean_grant_bonus)
    bandit = LinUCB(n_arms=N_ARMS, alpha=alpha, gamma=gamma, rng=np.random.default_rng(seed + 1))
    history = SiteHistory()

    t = 0.0
    cumulative_regret = np.zeros(n_rounds)
    arm_counts = np.zeros(N_ARMS, dtype=int)
    rewards = np.zeros(n_rounds)
    regret_running = 0.0

    for i in range(n_rounds):
        t += rng.exponential(mean_gap_min)
        hour = (t / 60) % 24
        day_of_week = int((t / (60 * 24)) % 7)
        recent_count = history.recent_count(t, DEFAULT_FREQUENCY_WINDOW_MIN)
        avg_recent = history.avg_recent_active(t)
        freq_24h = history.sessions_last_24h(t)

        x = np.array(build_context(hour, 0, day_of_week, freq_24h, avg_recent))
        risk = risk_for(hour, recent_count, avg_recent)

        # Oracle: best *expected* reward across all arms at this round's true risk.
        expected = [expected_reward_mc(d, risk, recent_count, settings, rng) for d in ARM_DURATIONS_MIN]
        oracle_reward = max(expected)

        arm_index, _ = bandit.select_arm(x)
        duration = ARM_DURATIONS_MIN[arm_index]
        active_minutes = sample_active_minutes(duration, risk, rng)
        reward = settings.deny_reward if duration == 0 else compute_grant_reward(active_minutes, recent_count, False, settings)

        bandit.update(arm_index, x, reward)
        history.record(t, active_minutes, was_grant=duration > 0)

        regret_running += oracle_reward - reward
        cumulative_regret[i] = regret_running
        arm_counts[arm_index] += 1
        rewards[i] = reward

    return {
        "cumulative_regret": cumulative_regret,
        "arm_counts": arm_counts,
        "rewards": rewards,
        "grant_rate": 1 - arm_counts[0] / n_rounds,
    }
