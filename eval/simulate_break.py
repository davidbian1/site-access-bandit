"""Does a LinUCB bandit over candidate break durations converge to something
sensible, under a reward shaped from override timing rather than an explicit
rating?

This tests the "take a break" feature proposed for the live extension
(see DESIGN.md's "Take a break" section) before any of it is built: right
now a break's length is a fixed number the user types in. The proposal is
to let a bandit suggest/pick it instead, using the same LinUCB machinery
the per-site duration bandit already uses, with a reward inferred from what
actually happened to the break rather than an added "rate this" prompt (the
whole design deliberately avoids that kind of extra friction — see
DESIGN.md's "Not recommending right now" note under learning suggestions).

Honest scope note, same as simulate.py: this is one illustrative model of
how a person's tolerance for a given break length might behave, not a
validated model of real behavior. It exists to answer one narrow question:
given *some* plausible relationship between context, a latent "how much
break was actually needed" quantity, and how a break gets cut short or
outlasted, does the proposed reward shape actually let the bandit learn a
policy close to that latent quantity, or does it produce something
degenerate (e.g. always picking the shortest or longest arm)?

Model:
- Each round has a latent "needed" duration T (minutes) — how long a break
  would have to be to actually feel done — drawn from a triangular
  distribution centered on a context-dependent D*(hour, fatigue): later in
  the evening and on higher cross-site "fatigue" days, D* is higher. T is
  never observed by the bandit, only the two context features that predict
  its distribution.
- If the chosen duration d <= T: the break runs its full length without
  being overridden, but wasn't enough — reward is the completion bonus
  minus a penalty scaled by how far short of T it fell.
- If d > T: the user might override before the break ends. How soon
  depends on "patience" — an exponential wait past T before the urge to
  override kicks in. Overriding early (long before d) is penalized more
  than overriding just before d would have ended anyway; sitting out the
  full excess without overriding earns the same completion bonus minus a
  small per-minute cost for the wasted excess time.
"""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np

from eval.linucb import LinUCB
from eval.reward import build_context

BREAK_DURATIONS_MIN = [10, 20, 30, 45, 60, 90, 120]
N_ARMS = len(BREAK_DURATIONS_MIN)
FEATURE_DIM = 7  # reuses build_context's shape; see fatigue note below
MC_SAMPLES = 200


@dataclass
class BreakRewardSettings:
    complete_bonus: float = 0.5
    too_short_penalty: float = 0.6
    override_penalty: float = 1.0
    waste_penalty_per_min: float = 0.01
    patience_min: float = 15.0


def ideal_duration(hour: float, fatigue_norm: float) -> float:
    """Ground-truth D* in minutes — not observed by the bandit. Higher in the
    evening and on higher-fatigue days; both are deliberately independent of
    each other so a context that only sees one of the two is missing real
    signal the other carries."""
    evening = 1.0 if 19 <= hour < 24 else 0.0
    base = 15.0 + 70.0 * fatigue_norm + 20.0 * evening
    return float(np.clip(base, 10.0, 130.0))


def sample_break_reward_batch(
    duration_min: float, ideal_min: float, rng: np.random.Generator, k: int, settings: BreakRewardSettings
) -> np.ndarray:
    spread_lo = 0.3 * ideal_min
    spread_hi = 0.5 * ideal_min
    low = max(3.0, ideal_min - spread_lo)
    high = ideal_min + spread_hi
    mode = float(np.clip(ideal_min, low, high))
    T = rng.triangular(low, mode, high, size=k)
    T = np.clip(T, 3.0, 180.0)

    too_short = duration_min <= T
    shortfall_frac = np.clip((T - duration_min) / np.maximum(T, 1e-6), 0.0, 1.0)
    reward_short = settings.complete_bonus - settings.too_short_penalty * shortfall_frac

    excess = np.maximum(duration_min - T, 0.0)
    override_wait = rng.exponential(settings.patience_min, size=k)
    override_time = T + override_wait
    overridden = (~too_short) & (override_time < duration_min)
    override_frac = np.clip(override_time / max(duration_min, 1e-6), 0.0, 1.0)
    reward_overridden = -settings.override_penalty * (1.0 - override_frac)
    reward_completed_excess = settings.complete_bonus - settings.waste_penalty_per_min * excess

    reward = np.where(too_short, reward_short, np.where(overridden, reward_overridden, reward_completed_excess))
    return np.clip(reward, -1.0, settings.complete_bonus)


def run_break_simulation(
    n_rounds: int = 400,
    alpha: float = 1.0,
    gamma: float = 0.99,
    seed: int = 0,
    settings: BreakRewardSettings | None = None,
) -> dict:
    settings = settings or BreakRewardSettings()
    rng = np.random.default_rng(seed)
    bandit = LinUCB(n_arms=N_ARMS, d=FEATURE_DIM, alpha=alpha, gamma=gamma, rng=np.random.default_rng(seed + 1))

    t = 0.0
    cumulative_regret = np.zeros(n_rounds)
    chosen_minus_ideal = np.zeros(n_rounds)
    regret_running = 0.0

    for i in range(n_rounds):
        t += rng.exponential(240.0)  # a break-worthy moment roughly every ~4h of "awake" time
        hour = (t / 60) % 24
        day_of_week = int((t / (60 * 24)) % 7)
        # Independent of time-of-day by design (a lazy Saturday vs. a busy
        # Tuesday) — fed through build_context's avg_recent_active_min slot,
        # which is otherwise unused here since this bandit isn't per-site.
        fatigue_norm = float(rng.beta(2.0, 2.0))
        x = np.array(build_context(hour, 0, day_of_week, 0.0, fatigue_norm * 60))

        ideal_min = ideal_duration(hour, fatigue_norm)
        expected = [
            float(np.mean(sample_break_reward_batch(d, ideal_min, rng, MC_SAMPLES, settings)))
            for d in BREAK_DURATIONS_MIN
        ]
        oracle_reward = max(expected)

        arm_index, _ = bandit.select_arm(x)
        duration = BREAK_DURATIONS_MIN[arm_index]
        reward = float(sample_break_reward_batch(duration, ideal_min, rng, 1, settings)[0])

        bandit.update(arm_index, x, reward)

        regret_running += oracle_reward - reward
        cumulative_regret[i] = regret_running
        chosen_minus_ideal[i] = duration - ideal_min

    return {
        "cumulative_regret": cumulative_regret,
        "final_regret": float(regret_running),
        "chosen_minus_ideal": chosen_minus_ideal,
        "mean_abs_gap_first_half": float(np.mean(np.abs(chosen_minus_ideal[: n_rounds // 2]))),
        "mean_abs_gap_second_half": float(np.mean(np.abs(chosen_minus_ideal[n_rounds // 2 :]))),
    }


def mean_over_seeds(n_rounds: int, alpha: float, gamma: float, seeds: tuple[int, ...]) -> dict:
    results = [run_break_simulation(n_rounds=n_rounds, alpha=alpha, gamma=gamma, seed=s) for s in seeds]
    return {
        "final_regret": float(np.mean([r["final_regret"] for r in results])),
        "mean_abs_gap_first_half": float(np.mean([r["mean_abs_gap_first_half"] for r in results])),
        "mean_abs_gap_second_half": float(np.mean([r["mean_abs_gap_second_half"] for r in results])),
    }


if __name__ == "__main__":
    seeds = (0, 1, 2, 3, 4)
    print("Shipped alpha (1.0, gamma=0.99):", mean_over_seeds(400, 1.0, 0.99, seeds))
    print("Tuned alpha (0.05, gamma=0.90):", mean_over_seeds(400, 0.05, 0.90, seeds))
