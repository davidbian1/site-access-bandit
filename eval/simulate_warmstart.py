"""Does warm-starting a new site's bandit from other sites' learned weights
reduce its early regret - and does it backfire when sites are genuinely
different from each other?

Each managed site currently gets its own LinUCB starting from pure
ignorance (A=I, b=0). The proposed fix: when a brand-new site has no data of
its own, initialize it from a shrinkage-weighted average of what other
managed sites have already learned, rather than from nothing. This module
tests whether that's actually a good idea, under two conditions:

- SIMILAR sites (near-identical risk profiles) - the best case for
  borrowing strength across sites.
- DISSIMILAR sites (deliberately different risk profiles) - the case that
  matters most: does warm-starting from sites that don't actually resemble
  the new one make things worse, not better?

Honest scope note, same as simulate.py/simulate_recency.py: illustrative,
not validated against real usage or real site-similarity patterns.
"""

from __future__ import annotations

import numpy as np

from eval.linucb import LinUCB, LinUCBArm
from eval.reward import (
    DEFAULT_DENY_REWARD,
    DEFAULT_DISCOUNT_FACTOR,
    DEFAULT_FREQUENCY_WINDOW_MIN,
    RewardSettings,
    build_context,
    compute_grant_reward,
    compute_grant_reward_batch,
)
from eval.simulate import ARM_DURATIONS_MIN, N_ARMS, SiteHistory, _sample_active_minutes_batch, risk_for, sample_active_minutes

MC_SAMPLES = 200
FEATURE_DIM = 7


def warm_start_arms(sibling_arm_states: list[list[dict]], n_arms: int, d: int, shrinkage: float) -> list[dict]:
    """Direct port of the proposed crossSiteWarmStart() for lib/background-helpers.js.
    sibling_arm_states is a list of "arms" lists (one per sibling site), each
    itself a list of {"A": ndarray, "b": ndarray} per arm index. Returns the
    initial [{"A", "b"}, ...] for a brand-new site's bandit.

    Averages each sibling's *learned* contribution (A minus its own identity
    baseline) rather than the raw A, so a site with more accumulated data
    doesn't also inject more regularization than a fresh site should start
    with - only the learned part is borrowed, scaled by shrinkage."""
    if shrinkage <= 0 or not sibling_arm_states:
        return [{"A": np.eye(d), "b": np.zeros(d)} for _ in range(n_arms)]

    arms = []
    for a in range(n_arms):
        learned_As = [sib[a]["A"] - np.eye(d) for sib in sibling_arm_states]
        bs = [sib[a]["b"] for sib in sibling_arm_states]
        avg_learned_A = np.mean(learned_As, axis=0)
        avg_b = np.mean(bs, axis=0)
        arms.append({
            "A": np.eye(d) + shrinkage * avg_learned_A,
            "b": shrinkage * avg_b,
        })
    return arms


def _bandit_from_arm_states(arm_states: list[dict], alpha: float, gamma: float, rng: np.random.Generator) -> LinUCB:
    bandit = LinUCB(n_arms=len(arm_states), d=FEATURE_DIM, alpha=alpha, gamma=gamma, rng=rng)
    for i, state in enumerate(arm_states):
        bandit.arms[i] = LinUCBArm(d=FEATURE_DIM, A=state["A"].copy(), b=state["b"].copy())
    return bandit


def _arm_states_from_bandit(bandit: LinUCB) -> list[dict]:
    return [{"A": arm.A.copy(), "b": arm.b.copy()} for arm in bandit.arms]


def _run_site(
    bandit: LinUCB,
    n_rounds: int,
    risk_params: dict,
    rng: np.random.Generator,
    settings: RewardSettings,
    mean_gap_min: float = 180.0,
) -> np.ndarray:
    """Runs one site for n_rounds, returning its per-round regret array.
    risk_params scales the qualitative risk_for() story from simulate.py so
    different sites can be made to genuinely differ (or not)."""
    history = SiteHistory()
    t = 0.0
    regret = np.zeros(n_rounds)

    for i in range(n_rounds):
        t += rng.exponential(mean_gap_min)
        hour = (t / 60) % 24
        day_of_week = int((t / (60 * 24)) % 7)
        recent_count = history.recent_count(t, DEFAULT_FREQUENCY_WINDOW_MIN)
        avg_recent = history.avg_recent_active(t)
        freq_24h = history.sessions_last_24h(t)

        x = np.array(build_context(hour, 0, day_of_week, freq_24h, avg_recent))
        base_risk = risk_for(hour, recent_count, avg_recent)
        if risk_params.get("invert"):
            base_risk = 1.0 - base_risk
        risk = float(np.clip(risk_params["scale"] * base_risk + risk_params["offset"], 0.0, 1.0))

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
        regret[i] = oracle_reward - reward

    return regret


def run_warmstart_trial(
    n_sibling_sites: int = 4,
    sibling_rounds: int = 300,
    new_site_rounds: int = 100,
    shrinkage: float = 0.0,
    similar_sites: bool = True,
    adversarial: bool = False,
    alpha: float = 1.0,
    gamma: float = DEFAULT_DISCOUNT_FACTOR,
    seed: int = 0,
) -> dict:
    """Trains n_sibling_sites independent bandits, then starts a new site
    either cold (shrinkage=0) or warm-started from the siblings' current
    learned state, and returns the new site's cumulative regret over its
    own first new_site_rounds rounds.

    adversarial=True is the genuine stress test: every sibling has an
    *inverted* risk pattern (night safe, day risky - the opposite of the
    new site's actual, "typical" pattern) rather than just a differently
    scaled version of the same pattern. If warm-starting still doesn't hurt
    under this, "dissimilar sites don't hurt" is a real finding, not an
    artifact of dissimilarity that wasn't actually adversarial enough."""
    rng = np.random.default_rng(seed)
    settings = RewardSettings(deny_reward=DEFAULT_DENY_REWARD)

    sibling_arm_states = []
    for s in range(n_sibling_sites):
        site_rng = np.random.default_rng(seed * 1000 + s)
        if adversarial:
            risk_params = {"scale": 1.0, "offset": 0.0, "invert": True}
        elif similar_sites:
            risk_params = {"scale": 1.0, "offset": 0.0}
        else:
            # Deliberately different per sibling: some much riskier, some
            # much safer, than the new site (which always uses scale=1,
            # offset=0 - the "typical" profile) will turn out to be.
            risk_params = {"scale": rng.choice([0.4, 0.7, 1.3, 1.8]), "offset": rng.uniform(-0.1, 0.1)}
        bandit = LinUCB(n_arms=N_ARMS, d=FEATURE_DIM, alpha=alpha, gamma=gamma, rng=site_rng)
        _run_site(bandit, sibling_rounds, risk_params, site_rng, settings)
        sibling_arm_states.append(_arm_states_from_bandit(bandit))

    new_site_arms = warm_start_arms(sibling_arm_states, N_ARMS, FEATURE_DIM, shrinkage)
    new_site_rng = np.random.default_rng(seed * 1000 + 999)
    new_bandit = _bandit_from_arm_states(new_site_arms, alpha, gamma, new_site_rng)
    new_site_risk_params = {"scale": 1.0, "offset": 0.0}  # the new site is always "typical"
    regret = _run_site(new_bandit, new_site_rounds, new_site_risk_params, new_site_rng, settings)

    return {"cumulative_regret": np.cumsum(regret), "final_regret": float(np.sum(regret))}


def compare_warmstart(
    shrinkages: tuple[float, ...] = (0.0, 0.15, 0.3, 0.5),
    similar_sites: bool = True,
    adversarial: bool = False,
    alpha: float = 1.0,
    gamma: float = DEFAULT_DISCOUNT_FACTOR,
    seeds: tuple[int, ...] = (0, 1, 2, 3, 4),
) -> dict:
    results = {}
    for shrinkage in shrinkages:
        finals = [
            run_warmstart_trial(shrinkage=shrinkage, similar_sites=similar_sites, adversarial=adversarial, alpha=alpha, gamma=gamma, seed=s)[
                "final_regret"
            ]
            for s in seeds
        ]
        results[shrinkage] = float(np.mean(finals))
    return results


if __name__ == "__main__":
    print("Similar sites, shipped alpha:", compare_warmstart(similar_sites=True, alpha=1.0, gamma=0.99))
    print("Dissimilar (scaled) sites, shipped alpha:", compare_warmstart(similar_sites=False, alpha=1.0, gamma=0.99))
    print("Adversarial (inverted) sites, shipped alpha:", compare_warmstart(adversarial=True, alpha=1.0, gamma=0.99))
    print("Similar sites, tuned alpha:", compare_warmstart(similar_sites=True, alpha=0.05, gamma=0.90))
    print("Adversarial (inverted) sites, tuned alpha:", compare_warmstart(adversarial=True, alpha=0.05, gamma=0.90))
