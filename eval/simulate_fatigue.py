"""Does adding a "total active time across all managed sites today" context
feature reduce regret, when the true risk of a grant genuinely depends on
cross-site activity that a per-site-only context can't see?

Today's real context (buildContext in lib/config.js) is built per site: a
site's own recent frequency and average recent active time, nothing about
what happened on any other managed site. The hypothesis this tests: binge
behavior often isn't confined to one site, so a model blind to "how much of
today has already gone to other managed sites" is missing a real signal —
see DESIGN.md's learning-suggestions notes.

Honest scope note, same as simulate.py: illustrative, not validated against
real multi-site usage. It exists to answer one narrow question with real
numbers: in an environment deliberately constructed so cross-site fatigue
matters, does giving the bandit that signal actually help, and — the more
important check — does it fail to hurt when cross-site fatigue turns out
not to matter at all (fatigue_coupling=0)? A feature that only helps when
you already know it matters and never costs anything when it doesn't is a
much safer addition than one that's a pure gamble.

Model: n_sites independent per-site bandits (same 4 arms as the real
extension), sharing one clock and one running "how many minutes have been
spent across ALL managed sites so far today" total. True risk for a grant
on any site is simulate.py's risk_for() (hour/frequency/recent-usage, same
as today) plus fatigue_coupling * today's cross-site total, normalized.
Two conditions are compared at matched settings: a 7-dim context (today's
real shape) vs an 8-dim context with the cross-site total appended.
"""

from __future__ import annotations

from collections import defaultdict

import numpy as np

from eval.linucb import LinUCB
from eval.reward import (
    DEFAULT_DENY_REWARD,
    DEFAULT_DISCOUNT_FACTOR,
    DEFAULT_FREQUENCY_WINDOW_MIN,
    RewardSettings,
    build_context,
    compute_grant_reward,
)
from eval.simulate import ARM_DURATIONS_MIN, N_ARMS, SiteHistory, expected_reward_mc, risk_for, sample_active_minutes

MC_SAMPLES = 200
FATIGUE_SATURATION_MIN = 120.0  # cross-site minutes/day at which the fatigue signal saturates to 1.0


def run_fatigue_simulation(
    n_sites: int = 3,
    n_rounds: int = 600,
    use_fatigue_feature: bool = True,
    fatigue_coupling: float = 0.3,
    alpha: float = 1.0,
    gamma: float = DEFAULT_DISCOUNT_FACTOR,
    seed: int = 0,
    mean_gap_min: float = 60.0,
) -> dict:
    rng = np.random.default_rng(seed)
    settings = RewardSettings(deny_reward=DEFAULT_DENY_REWARD)
    d = 8 if use_fatigue_feature else 7
    bandits = [LinUCB(n_arms=N_ARMS, d=d, alpha=alpha, gamma=gamma, rng=np.random.default_rng(seed * 1000 + s)) for s in range(n_sites)]
    histories = [SiteHistory() for _ in range(n_sites)]
    daily_totals: dict[int, float] = defaultdict(float)

    t = 0.0
    cumulative_regret = np.zeros(n_rounds)
    regret_running = 0.0

    for i in range(n_rounds):
        t += rng.exponential(mean_gap_min)
        site_idx = int(rng.integers(0, n_sites))
        hour = (t / 60) % 24
        day_of_week = int((t / (60 * 24)) % 7)
        day_idx = int(t // (24 * 60))

        history = histories[site_idx]
        recent_count = history.recent_count(t, DEFAULT_FREQUENCY_WINDOW_MIN)
        avg_recent = history.avg_recent_active(t)
        freq_24h = history.sessions_last_24h(t)

        fatigue_norm = min(1.0, daily_totals[day_idx] / FATIGUE_SATURATION_MIN)
        base_ctx = build_context(hour, 0, day_of_week, freq_24h, avg_recent)
        x = np.array(base_ctx + ([fatigue_norm] if use_fatigue_feature else []))

        true_risk = risk_for(hour, recent_count, avg_recent)
        combined_risk = float(np.clip(true_risk + fatigue_coupling * fatigue_norm, 0.0, 1.0))

        expected = [expected_reward_mc(dmin, combined_risk, recent_count, settings, rng, k=MC_SAMPLES) for dmin in ARM_DURATIONS_MIN]
        oracle_reward = max(expected)

        bandit = bandits[site_idx]
        arm_index, _ = bandit.select_arm(x)
        duration = ARM_DURATIONS_MIN[arm_index]
        active_minutes = sample_active_minutes(duration, combined_risk, rng)
        reward = settings.deny_reward if duration == 0 else compute_grant_reward(active_minutes, recent_count, False, settings)

        bandit.update(arm_index, x, reward)
        history.record(t, active_minutes, was_grant=duration > 0)
        daily_totals[day_idx] += active_minutes

        regret_running += oracle_reward - reward
        cumulative_regret[i] = regret_running

    return {"cumulative_regret": cumulative_regret, "final_regret": float(regret_running)}


def compare_fatigue_feature(
    fatigue_couplings: tuple[float, ...] = (0.0, 0.15, 0.3, 0.5),
    alpha: float = 1.0,
    gamma: float = DEFAULT_DISCOUNT_FACTOR,
    seeds: tuple[int, ...] = (0, 1, 2, 3, 4),
) -> dict:
    results = {}
    for coupling in fatigue_couplings:
        without = [
            run_fatigue_simulation(use_fatigue_feature=False, fatigue_coupling=coupling, alpha=alpha, gamma=gamma, seed=s)["final_regret"]
            for s in seeds
        ]
        with_feature = [
            run_fatigue_simulation(use_fatigue_feature=True, fatigue_coupling=coupling, alpha=alpha, gamma=gamma, seed=s)["final_regret"]
            for s in seeds
        ]
        results[coupling] = {
            "without_fatigue_feature": float(np.mean(without)),
            "with_fatigue_feature": float(np.mean(with_feature)),
        }
    return results


if __name__ == "__main__":
    print("Shipped alpha:", compare_fatigue_feature(alpha=1.0, gamma=0.99))
    print("Tuned alpha:", compare_fatigue_feature(alpha=0.05, gamma=0.90))
