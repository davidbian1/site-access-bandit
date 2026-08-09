"""Does telling the bandit "how long since you were last here" reduce regret?

Companion to simulate.py, not a replacement — reuses its LinUCB port and
reward logic, but needs its own environment because the question here is
specifically about adding an 8th context dimension, which simulate.py's
single 7-dim build_context() can't represent.

Honest scope note, same as simulate.py: illustrative, not validated against
real usage. The ground-truth risk model here is deliberately constructed so
recency-since-last-visit carries a real, independent signal (a quick return
raises risk even when the existing 30-minute frequency window and 5-session
average active time both read as unremarkable) — the whole point is to ask
"if this information matters, can the bandit actually use it," not to
assume the answer.
"""

from __future__ import annotations

import math
from dataclasses import dataclass, field

import numpy as np

from eval.linucb import LinUCB
from eval.reward import (
    DEFAULT_DENY_REWARD,
    DEFAULT_DISCOUNT_FACTOR,
    DEFAULT_FREQUENCY_WINDOW_MIN,
    RewardSettings,
    compute_grant_reward,
    compute_grant_reward_batch,
)
from eval.simulate import ARM_DURATIONS_MIN, N_ARMS, _sample_active_minutes_batch, sample_active_minutes

MC_SAMPLES = 200

RECENCY_CAP_HOURS = 48.0  # matches the normalization proposed for the live extension


def recency_feature(hours_since_last: float | None) -> float:
    """Normalized recency signal: 0 = just visited, 1 = never visited before
    or it's been RECENCY_CAP_HOURS+ - mirrors the normalization style every
    other buildContext() feature already uses (min(1, raw/cap))."""
    if hours_since_last is None:
        return 1.0
    return min(1.0, hours_since_last / RECENCY_CAP_HOURS)


def build_context_recency(
    hour: float, minute: float, day_of_week: int, freq_24h: float, avg_recent_active_min: float, hours_since_last: float | None
) -> list[float]:
    """The 7 existing features plus recency_feature() as an 8th dimension."""
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
        recency_feature(hours_since_last),
    ]


def risk_for_recency(hour: float, recent_session_count: int, avg_recent_active_min: float, hours_since_last: float | None) -> float:
    """Ground truth risk, rebalanced from simulate.risk_for to make room for
    a recency term (weights still sum to 1.0 at saturation): a return within
    2 hours is treated as a meaningfully riskier context than one further
    out, independent of whether the 30-minute frequency window or the
    5-session average already flagged anything - this is the signal the
    recency feature exists to expose."""
    night = 1.0 if (hour >= 22 or hour < 2) else (0.4 if (hour >= 20 or hour < 6) else 0.0)
    frequency_signal = min(1.0, recent_session_count / 4)
    usage_signal = min(1.0, avg_recent_active_min / 20)
    if hours_since_last is None:
        recency_signal = 0.0
    elif hours_since_last < 2:
        recency_signal = 1.0
    elif hours_since_last < 6:
        recency_signal = 0.5
    else:
        recency_signal = 0.0
    risk = 0.05 + 0.25 * night + 0.25 * frequency_signal + 0.20 * usage_signal + 0.25 * recency_signal
    return float(min(1.0, risk))


@dataclass
class SiteHistoryRecency:
    """Same session-log role as simulate.SiteHistory, extended to track the
    most recent session's end time so hours_since_last() can be derived -
    mirrors how recentStatsFor() would need to be extended in
    lib/background-helpers.js to support this feature."""

    sessions: list[tuple[float, float, bool]] = field(default_factory=list)  # (t, active_minutes, was_grant)

    def record(self, t: float, active_minutes: float, was_grant: bool) -> None:
        self.sessions.append((t, active_minutes, was_grant))

    def recent_count(self, t: float, window_min: float) -> int:
        return sum(1 for ts, _, was_grant in self.sessions if was_grant and t - ts <= window_min)

    def avg_recent_active(self, t: float, n: int = 5) -> float:
        recent = [m for _, m, _ in self.sessions[-n:]]
        return float(np.mean(recent)) if recent else 0.0

    def sessions_last_24h(self, t: float) -> int:
        return sum(1 for ts, _, _ in self.sessions if t - ts <= 24 * 60)

    def hours_since_last(self, t: float) -> float | None:
        if not self.sessions:
            return None
        last_t = self.sessions[-1][0]
        return (t - last_t) / 60.0


def run_simulation_recency(
    n_rounds: int = 500,
    alpha: float = 1.0,
    gamma: float = DEFAULT_DISCOUNT_FACTOR,
    clean_grant_bonus: float = 0.0,
    seed: int = 0,
    mean_gap_min: float = 90.0,
    use_recency_feature: bool = True,
) -> dict:
    """mean_gap_min defaults lower than simulate.py's 180 (vs. 90 here) so
    quick-return rounds - the exact scenario the recency feature exists to
    catch - actually occur often enough in a 500-round run to matter."""
    rng = np.random.default_rng(seed)
    settings = RewardSettings(deny_reward=DEFAULT_DENY_REWARD, clean_grant_bonus=clean_grant_bonus)
    d = 8 if use_recency_feature else 7
    bandit = LinUCB(n_arms=N_ARMS, d=d, alpha=alpha, gamma=gamma, rng=np.random.default_rng(seed + 1))
    history = SiteHistoryRecency()

    t = 0.0
    cumulative_regret = np.zeros(n_rounds)
    regret_running = 0.0
    grant_count = 0

    for i in range(n_rounds):
        t += rng.exponential(mean_gap_min)
        hour = (t / 60) % 24
        day_of_week = int((t / (60 * 24)) % 7)
        recent_count = history.recent_count(t, DEFAULT_FREQUENCY_WINDOW_MIN)
        avg_recent = history.avg_recent_active(t)
        freq_24h = history.sessions_last_24h(t)
        hours_since_last = history.hours_since_last(t)

        risk = risk_for_recency(hour, recent_count, avg_recent, hours_since_last)

        if use_recency_feature:
            x = np.array(build_context_recency(hour, 0, day_of_week, freq_24h, avg_recent, hours_since_last))
        else:
            # Recency-blind: identical features, minus the 8th dimension -
            # this bandit's context genuinely cannot distinguish "just
            # visited" from "haven't been here in a week."
            full = build_context_recency(hour, 0, day_of_week, freq_24h, avg_recent, hours_since_last)
            x = np.array(full[:7])

        # Oracle uses the *true* risk (same for both arms of the comparison)
        # to score each duration's expected reward, vectorized the same way
        # simulate.py's expected_reward_mc is - both bandits are judged
        # against the same ground truth, only their own visibility into it differs.
        expected = []
        for dmin in ARM_DURATIONS_MIN:
            if dmin == 0:
                expected.append(settings.deny_reward)
            else:
                samples = _sample_active_minutes_batch(dmin, risk, rng, MC_SAMPLES)
                rewards = compute_grant_reward_batch(samples, recent_count, False, settings)
                expected.append(float(np.mean(rewards)))
        oracle_reward = max(expected)

        arm_index, _ = bandit.select_arm(x)
        duration = ARM_DURATIONS_MIN[arm_index]
        active_minutes = sample_active_minutes(duration, risk, rng)
        reward = settings.deny_reward if duration == 0 else compute_grant_reward(active_minutes, recent_count, False, settings)

        bandit.update(arm_index, x, reward)
        history.record(t, active_minutes, was_grant=duration > 0)

        regret_running += oracle_reward - reward
        cumulative_regret[i] = regret_running
        if duration > 0:
            grant_count += 1

    return {"cumulative_regret": cumulative_regret, "grant_rate": grant_count / n_rounds}


def compare_recency_feature(
    alpha: float = 1.0,
    gamma: float = DEFAULT_DISCOUNT_FACTOR,
    clean_grant_bonus: float = 0.0,
    n_rounds: int = 500,
    seeds: tuple[int, ...] = (0, 1, 2, 3, 4),
) -> dict:
    with_recency = [
        run_simulation_recency(n_rounds=n_rounds, alpha=alpha, gamma=gamma, clean_grant_bonus=clean_grant_bonus, seed=s, use_recency_feature=True)
        for s in seeds
    ]
    without_recency = [
        run_simulation_recency(n_rounds=n_rounds, alpha=alpha, gamma=gamma, clean_grant_bonus=clean_grant_bonus, seed=s, use_recency_feature=False)
        for s in seeds
    ]
    return {
        "with_recency_final_regret": float(np.mean([r["cumulative_regret"][-1] for r in with_recency])),
        "without_recency_final_regret": float(np.mean([r["cumulative_regret"][-1] for r in without_recency])),
        "with_recency_grant_rate": float(np.mean([r["grant_rate"] for r in with_recency])),
        "without_recency_grant_rate": float(np.mean([r["grant_rate"] for r in without_recency])),
    }


if __name__ == "__main__":
    print("Tuned alpha/gamma, no bonus:", compare_recency_feature(alpha=0.05, gamma=0.90, clean_grant_bonus=0.0))
    print("Shipped alpha/gamma, no bonus:", compare_recency_feature(alpha=1.0, gamma=0.99, clean_grant_bonus=0.0))
    print("Shipped alpha/gamma, with clean-grant bonus:", compare_recency_feature(alpha=1.0, gamma=0.99, clean_grant_bonus=0.2))
    print("Tuned alpha/gamma, with clean-grant bonus:", compare_recency_feature(alpha=0.05, gamma=0.90, clean_grant_bonus=0.2))
