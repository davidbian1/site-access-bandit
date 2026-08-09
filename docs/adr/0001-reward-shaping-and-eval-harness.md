# 0001. Offline evaluation harness, and an opt-in fix for the reward ceiling

## Status

Accepted — the `eval/` harness and the opt-in `cleanGrantBonus` setting are
merged. `cleanGrantBonus` itself defaults to `0` (off); enabling it in a real
install is a separate, not-yet-made decision — see Consequences.

## Context

The bandit "didn't seem to learn well." That's a feeling, not a diagnosis, so
before changing anything, `lib/config.js` and `lib/linucb.js` were read
closely for concrete, checkable causes rather than guessing. Two candidates
came out of that:

1. **`DEFAULT_ALPHA = 1.0`** might be miscalibrated for this reward scale.
   Rewards span roughly `[-1, 0.15]` — under 1.2 wide — and LinUCB's
   exploration bonus (`alpha * sqrt(variance)`) can be the same order of
   magnitude as that whole range early on, which would look like slow
   learning but actually be persistent, costly exploration.
2. **`computeGrantReward()`'s ceiling at 0** means no grant can ever
   out-score a denial that stands (`DEFAULT_DENY_REWARD`, a fixed `+0.15`
   regardless of context). If true, this isn't a bug so much as a structural
   limit: the bandit cannot, even with unlimited data, learn "granting is
   right in this context," because a grant's best possible reward (`0`) is
   still below a denial's guaranteed one (`0.15`).

Neither of these could be confirmed by reading the code alone — both needed
to actually be run against something.

## Decision

Build a small offline evaluation harness (`eval/`) rather than tuning by
feel, and add one new opt-in setting based on what it found.

### Tooling justification

Everything below was added because the specific task needed it, not because
it's a common industry keyword — see `docs/adr/README.md` for the convention
this is meant to model for any future addition:

- **NumPy** — `eval/linucb.py` is a from-scratch port of the ridge-regression
  math in `lib/linucb.js` (the extension has no build step by design, so
  importing the JS file directly into a Python harness wasn't an option).
  Matrix inversion and vectorized reward sampling need real linear algebra;
  the alternative was hand-rolling it a second time, in a second language.
- **Optuna** — produced the actual alpha/gamma finding below via search, not
  a few hand-picked values. This was the direct answer to "which tools help
  with the learning itself."
- **Matplotlib** — renders exactly two plots in the notebook (regret curve,
  regret/grant-rate comparison). Lowest-dependency plotting option; the
  alternative was numbers with no visual read on the trend.
- **pytest** — runs `eval/test_linucb.py` and `eval/test_reward.py` (13
  tests). Same role `node --test` already plays on the JS side, mirrored for
  the Python side, not a redundant second framework for the same code.
- **Jupyter + nbconvert** — builds and executes `notebooks/bandit_tuning.ipynb`
  once, so its plots and numbers are real (computed live), not hand-typed.

`pandas` was in an earlier draft of `eval/requirements.txt` and never
actually used — removed rather than kept "for later."

### What the simulation found

`eval/simulate.py` is a synthetic single-site environment (documented
limitations below) that lets the real `LinUCB` implementation run against a
ground-truth "risk" function it can't see, so regret against an oracle can
be measured. All numbers below came from executing
`notebooks/bandit_tuning.ipynb` — reproducible by re-running it.

> **Corrected 2026-08 — see "Update" at the end of this ADR.** The table
> below reflects a fidelity bug found in `SiteHistory.recent_count()` during
> a later review: it counted denials toward the frequency signal, which the
> real `recentStatsFor()` never does. The qualitative conclusions are
> unchanged, but the exact numbers are not what the original pass reported —
> see the Update section for the original (now-superseded) figures and why
> they moved.

| Configuration | Final regret (300 rounds) | Grant rate |
|---|---|---|
| Shipped defaults (`alpha=1.0`, `gamma=0.99`, `cleanGrantBonus=0`) | **20.9** | 31.6% |
| Optuna-tuned (`alpha≈0.05`, `gamma≈0.90`), same reward shape | **0.26** | 0.6% |
| Optuna-tuned alpha/gamma, `cleanGrantBonus=0.2` | 7.53 | 13.6% |
| Shipped `alpha=1.0`, `cleanGrantBonus=0.2` | 13.1 | 61.0% |

Both hypotheses held up, and turned out to be linked rather than separate
problems:

- **Alpha was genuinely miscalibrated.** The shipped default produces
  roughly **80x more regret** than the tuned value in this environment — not
  slow learning, over-exploration. This is the higher-confidence finding of
  the two, and the one number that barely moved after the fidelity fix
  (was ~81x, now ~79x) — this conclusion doesn't depend on the frequency
  bug either way.
- **Tuning alpha down fixes the regret, but exposes the ceiling.** At the
  tuned alpha, the model converges hard toward *always denying* (grant rate
  collapses to ~0.6%), because once exploration is efficient there's nothing
  left pulling it toward granting — the reward ceiling means grant can only
  ever look worse than deny on the mean, once uncertainty is resolved.
- **The clean-grant bonus is a real lever, not a free win — and which way it
  moves regret depends on whether alpha is already well-tuned.** At the
  *tuned* alpha it restores granting substantially (0.6% → 13.6%) but regret
  goes *up* (0.26 → 7.53) — most grant attempts in a risk-heavy synthetic
  environment aren't "clean," so the exploration it re-enables hasn't paid
  for itself by round 300 in this model. At the *shipped* (already
  over-exploring) alpha, the opposite happens: regret goes *down* with the
  bonus enabled (20.9 → 13.1), because in that already-miscalibrated regime
  the extra grants the bonus permits include enough genuinely-clean ones to
  net out ahead. Neither of these is "the" answer for whether to enable it —
  the honest reading is that its effect is coupled to alpha, not independent
  of it, which is itself a reason not to tune the two in isolation.

### What changed in the live extension

`lib/config.js` gained `DEFAULT_CLEAN_GRANT_BONUS = 0` (off) and
`CLEAN_GRANT_MAX_ACTIVE_MINUTES`, plus the corresponding branch in
`computeGrantReward()`. With the default value, behavior is byte-identical
to before this change — pinned by
`computeGrantReward: cleanGrantBonus is off by default` in
`lib/config.test.js`. `DEFAULT_ALPHA` and `DEFAULT_DISCOUNT_FACTOR` were
**not** changed in this pass — see Consequences.

## Consequences

- **Alpha was not changed.** The 80x regret finding is the strongest result
  here, but it comes from a synthetic environment whose risk model was
  written for this exercise, not fit to real usage logs. Recommending
  `alpha≈0.05` as a new *default* without validating against real session
  data would be overfitting the simulation. The honest next step is
  exporting real logged sessions and re-running `eval/tune.py` against them
  before touching `DEFAULT_ALPHA`.
- **`cleanGrantBonus` ships off.** The simulation showed it's a genuine
  trade-off (more grants, more regret over the tested horizon), not a clear
  win — turning it on for a real install should be a deliberate choice made
  after reading this, not a default flipped on the strength of a synthetic
  result.
- **The Python port must be kept in sync with `lib/linucb.js` /
  `lib/config.js` by hand.** There's no shared source of truth across the
  two languages. `test_reward.py`'s and `config.test.js`'s overlapping test
  names are the tripwire for drift, but this is a real, accepted
  maintenance cost, not a solved problem.
- **The synthetic risk model is illustrative, not validated.** It encodes
  one plausible story (risk rises at night and with recent frequency/usage)
  chosen to be qualitatively consistent with `lib/config.js`'s own existing
  comments about frequency and duration penalties — it was not fit to any
  real behavioral data. Numbers above are useful for comparing
  configurations *against each other*, not as absolute predictions of real
  usage.
- **Heavier tooling (Kubernetes, MLflow, a model-serving framework, a
  managed cloud ML platform, Prometheus/Grafana, drift-detection tooling)
  was considered and explicitly not added here** — see chat history and
  `docs/adr/README.md`'s convention. Any future proposal for one of those
  gets its own ADR, justified against a real, current need at this
  project's actual scale, not added speculatively.

## Update — 2026-08, fidelity bug found and fixed

A later review (looking at this ADR while evaluating two unrelated
proposed features) found a real fidelity bug in `SiteHistory.recent_count()`
in `eval/simulate.py`: it counted *every* recorded round, including
denials, toward the frequency signal fed into `compute_grant_reward()`. The
real `recentStatsFor()` in `lib/background-helpers.js` only counts sessions
where `decision === 'grant'` toward `sessionsInFrequencyWindow`. Since
denials are frequent in this environment (especially at the tuned, low-alpha
regime where grant rate collapses to ~0.6%), the simulated frequency penalty
was applied more aggressively than the real reward function ever would,
directly affecting how often a grant qualified as "clean"
(`recentSessionCount === 0`).

Fixed by tracking `was_grant` per recorded round and filtering
`recent_count()` to only count grants — `avg_recent_active()` and
`sessions_last_24h()` were already correctly unfiltered (the real
`avgRecentActiveMin`/`sessionsLast24h` don't filter by decision either, so
those two needed no change). Regression tests added in
`eval/test_simulate.py`.

**Original (superseded) numbers, for the record:**

| Configuration | Final regret (300 rounds) | Grant rate |
|---|---|---|
| Shipped defaults | 21.1 | 30.0% |
| Optuna-tuned, same reward shape | 0.26 | 0.6% |
| Optuna-tuned, `cleanGrantBonus=0.2` | 6.44 | 8.4% |
| Shipped alpha, `cleanGrantBonus=0.2` | 17.7 | 56.2% |

**What changed after the fix:** the alpha-miscalibration finding was
essentially unchanged (~81x → ~79x regret ratio — that finding never
depended on frequency counting). The clean-grant-bonus numbers moved more:
regret at tuned alpha went *up* after the fix (6.44 → 7.53, bonus is a
clearer trade-off than first reported), while regret at shipped alpha went
*down* enough to flip which direction the bonus points in that regime (17.7
→ 13.1, now *below* the no-bonus baseline of 20.9) — a real, previously
unreported nuance: whether the bonus helps or hurts regret depends on
whether alpha is already well-tuned, not just on the bonus itself. No
decision recorded in this ADR (alpha unchanged, `cleanGrantBonus` still
ships off) needed to change as a result — the fix sharpened the picture
without overturning either one.
