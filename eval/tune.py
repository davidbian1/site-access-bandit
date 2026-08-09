"""Optuna sweep over LinUCB's alpha/gamma, run against the synthetic
environment in simulate.py. Answers the question "is DEFAULT_ALPHA=1.0 a
reasonable choice for this reward scale" with a number instead of a guess —
see docs/adr/0001-reward-shaping-and-eval-harness.md for the result.

Usage: python -m eval.tune
"""

from __future__ import annotations

import numpy as np
import optuna

from eval.simulate import run_simulation

N_ROUNDS = 300
SEEDS = (0, 1, 2)


def mean_final_regret(alpha: float, gamma: float, clean_grant_bonus: float) -> float:
    finals = []
    for seed in SEEDS:
        result = run_simulation(
            n_rounds=N_ROUNDS,
            alpha=alpha,
            gamma=gamma,
            clean_grant_bonus=clean_grant_bonus,
            seed=seed,
        )
        finals.append(result["cumulative_regret"][-1])
    return float(np.mean(finals))


def objective(trial: optuna.Trial) -> float:
    alpha = trial.suggest_float("alpha", 0.05, 2.0, log=True)
    gamma = trial.suggest_float("gamma", 0.9, 1.0)
    return mean_final_regret(alpha, gamma, clean_grant_bonus=0.0)


def run_tuning(n_trials: int = 20) -> optuna.Study:
    optuna.logging.set_verbosity(optuna.logging.WARNING)
    study = optuna.create_study(direction="minimize")
    study.optimize(objective, n_trials=n_trials, show_progress_bar=False)
    return study


def compare_reward_variants(alpha: float, gamma: float) -> dict:
    """Compares the live-default reward shape (clean_grant_bonus=0, matches
    lib/config.js today) against the opt-in bonus variant, at a fixed
    alpha/gamma, over multiple seeds."""
    baseline = [run_simulation(n_rounds=N_ROUNDS, alpha=alpha, gamma=gamma, clean_grant_bonus=0.0, seed=s) for s in SEEDS]
    bonus = [run_simulation(n_rounds=N_ROUNDS, alpha=alpha, gamma=gamma, clean_grant_bonus=0.2, seed=s) for s in SEEDS]
    return {
        "baseline_final_regret": float(np.mean([r["cumulative_regret"][-1] for r in baseline])),
        "bonus_final_regret": float(np.mean([r["cumulative_regret"][-1] for r in bonus])),
        "baseline_grant_rate": float(np.mean([r["grant_rate"] for r in baseline])),
        "bonus_grant_rate": float(np.mean([r["grant_rate"] for r in bonus])),
    }


if __name__ == "__main__":
    study = run_tuning()
    print("Best alpha/gamma found:", study.best_params)
    print("Mean final regret at best params:", study.best_value)

    default_result = mean_final_regret(alpha=1.0, gamma=0.99, clean_grant_bonus=0.0)
    print("Mean final regret at current DEFAULT_ALPHA=1.0, DEFAULT_DISCOUNT_FACTOR=0.99:", default_result)

    comparison = compare_reward_variants(alpha=study.best_params["alpha"], gamma=study.best_params["gamma"])
    print("Reward variant comparison at tuned alpha/gamma:", comparison)
