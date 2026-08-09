"""NumPy port of lib/linucb.js — disjoint LinUCB contextual bandit (Li et al., 2010).

This is a deliberate re-implementation, not a code-share with the JS version:
the extension has no build step by design (see DESIGN_DECISIONS.md), so there's
no clean way to import lib/linucb.js into a Python evaluation harness without
adding a JS runtime dependency to this side of the project. Keeping the two in
sync is a manual, documented trade-off — see docs/adr/0001-reward-shaping-and-eval-harness.md.

Each arm keeps its own ridge-regression state: A (d x d), b (d,).
UCB score for arm a given context x: theta_a^T x + alpha * sqrt(x^T A_a^-1 x)
gamma (default 1 = off) discounts A/b before each update, identical semantics
to LinUCBArm.update() in lib/linucb.js, including re-adding (1-gamma)*I so the
ridge regularization doesn't fade away along with the discounted data.
"""

from __future__ import annotations

from dataclasses import dataclass, field

import numpy as np

FEATURE_DIM = 7


@dataclass
class LinUCBArm:
    d: int
    A: np.ndarray = field(default=None)
    b: np.ndarray = field(default=None)

    def __post_init__(self):
        if self.A is None:
            self.A = np.eye(self.d)
        if self.b is None:
            self.b = np.zeros(self.d)

    def score(self, x: np.ndarray, alpha: float) -> tuple[float, float, float]:
        A_inv = np.linalg.inv(self.A)
        theta = A_inv @ self.b
        mean = float(theta @ x)
        variance = float(np.sqrt(max(0.0, x @ A_inv @ x)))
        return mean + alpha * variance, mean, variance

    def update(self, x: np.ndarray, reward: float, gamma: float = 1.0) -> None:
        regularization = (1 - gamma) * np.eye(self.d)
        self.A = gamma * self.A + regularization + np.outer(x, x)
        self.b = gamma * self.b + reward * x


class LinUCB:
    def __init__(self, n_arms: int, d: int = FEATURE_DIM, alpha: float = 1.0, gamma: float = 1.0, rng: np.random.Generator | None = None):
        self.d = d
        self.alpha = alpha
        self.gamma = gamma
        self.arms = [LinUCBArm(d) for _ in range(n_arms)]
        self.rng = rng or np.random.default_rng()

    def select_arm(self, x: np.ndarray) -> tuple[int, list[tuple[float, float, float]]]:
        scores = [arm.score(x, self.alpha) for arm in self.arms]
        ucbs = [s[0] for s in scores]
        best = max(ucbs)
        candidates = [i for i, u in enumerate(ucbs) if abs(u - best) <= 1e-9]
        arm_index = int(self.rng.choice(candidates))
        return arm_index, scores

    def update(self, arm_index: int, x: np.ndarray, reward: float) -> None:
        self.arms[arm_index].update(x, reward, self.gamma)
