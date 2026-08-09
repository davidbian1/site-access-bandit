# 0002. Two proposed learning improvements, tested before shipping either

## Status

Accepted — cross-site warm-start ships, opt-in-by-default-value rather than
opt-in-by-flag (default shrinkage `0.2`, `0` fully disables it). The recency
feature does **not** ship — tested and rejected, not merely deferred.

## Context

Two candidate improvements to the bandit's learning were proposed in
conversation, both aimed at problems ADR 0001 didn't address:

1. **A recency feature.** Nothing in the current 7-dimensional context
   (`lib/config.js`'s `buildContext()`) distinguishes "just visited" from
   "haven't been here in a week" — the 24h count and 5-session average
   active time are both about volume/intensity, not time-since-last-visit
   specifically.
2. **Cross-site warm-start.** Every managed site's `LinUCB` starts from
   pure ignorance (`A=I`, `b=0`), even when other managed sites already
   have plenty of learned data. `DESIGN.md` already flags this as an open
   question ("why disjoint per-site models rather than a shared/hybrid
   one").

Following the precedent ADR 0001 set (measure before shipping, don't trust
a plausible-sounding idea on its own), both were built as `eval/` experiments
before any live-extension code was written. Both experiments reuse
`eval/linucb.py`/`eval/reward.py` rather than re-deriving the math.

## Decision

### Recency feature — tested, rejected

`eval/simulate_recency.py` runs two bandits against an *identical* ground
truth where recency-since-last-visit is a real, independent risk factor (a
return within 2 hours is modeled as meaningfully riskier, regardless of
what the existing frequency/usage features already show) — one bandit sees
an 8th context dimension carrying that signal, one doesn't.

| Regime | With recency | Without recency |
|---|---|---|
| Shipped alpha/gamma, no bonus (5 seeds) | 23.77 | 23.84 |
| Shipped alpha/gamma, no bonus (20 seeds) | 23.97 | 23.68 |
| Shipped alpha/gamma, `cleanGrantBonus=0.2` | 24.25 | 23.89 |
| Tuned alpha/gamma, no bonus | 0.59 | 0.62 |
| Tuned alpha/gamma, `cleanGrantBonus=0.2` | 1.77 | 1.73 |

The effect is small (~1%) and **flips direction** between the 5-seed and
20-seed runs of the same regime — that's noise, not signal. **Rejected**:
adding an 8th dimension has a real cost (more parameters to learn, more
exploration needed before the UCB confidence term shrinks, a
persisted-data-format migration for existing installs) and this experiment
found no reliable benefit to offset it. The working theory for *why* it
doesn't help: at the tuned alpha, the model converges to an
almost-always-deny policy fast enough that context differences — recency
included — rarely get the chance to matter (see the cross-site section
below for the same convergence behavior showing up again); at the shipped
alpha, the extra dimension's exploration cost plausibly cancels out
whatever the recency signal was worth over the tested horizon. Neither
mechanism was confirmed directly — the honest conclusion is the net effect
measured, not the mechanism guessed at.

### Cross-site warm-start — tested, shipped

`eval/simulate_warmstart.py` trains several "sibling" sites, then starts a
new site either cold (`shrinkage=0`) or initialized from a
shrinkage-weighted average of the siblings' *learned* contribution
(`A - I`, `b`) — the port intended for `lib/background-helpers.js` is
`warm_start_arms()` in that file, math identical to what
`crossSiteWarmStart()` implements live.

| Sibling condition | 0.0 | 0.15 | 0.3 | 0.5 |
|---|---|---|---|---|
| Similar siblings | 11.38 | 10.91 | 9.85 | **8.00** |
| Dissimilar (scaled) siblings | 11.38 | 11.26 | 10.40 | **8.02** |
| Adversarial (inverted risk) siblings | 11.38 | 11.29 | 10.81 | **6.72** |

Warm-starting reduced regret monotonically with shrinkage in every
condition tested, at the current shipped reward defaults (`cleanGrantBonus=0`)
— including the deliberately adversarial case where siblings' risk pattern
is *inverted* relative to the new site's, not just differently scaled. That
last result was surprising enough to distrust on its own, so it was
stress-tested two further ways before being believed:

- **Confound check: is this just "a bigger A means less exploration
  variance," independent of what's actually borrowed?** Tested a "fake"
  warm start — scaled identity `A`, `b=0`, no borrowed direction at all.
  It reduced regret only slightly (11.92 → 11.06 across scale 1→3), far
  less than the ~30-40% reduction from real warm-starting. The confound is
  real but small, not the main effect.
- **Does the story change once denial doesn't dominate as heavily?** Under
  `cleanGrantBonus=0.2` with adversarial siblings, the result was **not**
  monotonic — shrinkage `0.15`/`0.3` were *worse* than cold-start (6.62,
  6.69 vs. 6.14), only `0.5` came out ahead again (3.96). This is the
  important caveat: the "adversarial siblings don't hurt" finding is
  coupled to how strongly the reward ceiling favors denying by default
  (ADR 0001). It held at the current shipped reward shape; it is **not**
  established to hold if `cleanGrantBonus` is ever turned on.

**Working explanation, not a confirmed mechanism**: given ADR 0001's
finding that denying is the reward-dominant choice almost everywhere under
current defaults, *any* reasonably-confident prior — even one pointing the
wrong direction on which contexts are risky — plausibly speeds convergence
toward a denial-leaning policy that's usually close to correct anyway. That
would explain both why warm-start helps broadly today, and why the benefit
got less predictable once `cleanGrantBonus` reduced how dominant denying
is. This was not confirmed by inspecting the bandits' actual learned
`theta` directly — a real next step if this needs more confidence later.

## Consequences

- **Cross-site warm-start ships, default shrinkage `0.2`.** The evidence
  supports it clearly at every shrinkage tested, and `0.5` was the
  best-performing value in *every* tested condition — but `0.2` was chosen
  deliberately over the empirically-best value, for the same reason ADR
  0001 declined to update `DEFAULT_ALPHA`: shipping the simulation's
  optimum as a real default would be overfitting one synthetic environment
  with a handful of seeds. `0` fully disables it (reproducing today's
  behavior exactly), and it's editable in settings like every other bandit
  parameter — someone who watches their own results and wants to push it
  toward `0.5` can.
- **The recency feature does not ship**, and `FEATURE_DIM` stays at 7.
  This is a real, deliberate output of this ADR, not an omission — the
  experiment is the evidence for *not* building it, which is exactly the
  kind of thing worth writing down before someone (human or otherwise)
  proposes it again without checking first.
- **The "adversarial siblings don't hurt" finding is conditional, not
  universal.** It's true at today's shipped reward shape. If
  `cleanGrantBonus` is ever enabled, this ADR's own data shows the
  interaction gets less predictable — that combination has not been
  validated and should be re-checked in `eval/` before both are ever
  enabled together in a real install.
- **Neither experiment's ground-truth model is validated against real
  usage** — same standing limitation as ADR 0001. These numbers compare
  configurations against each other within one synthetic environment; they
  are not predictions of real regret.
- **The Python/JS sync burden grows by one more file.**
  `eval/simulate_warmstart.py`'s `warm_start_arms()` must be kept
  consistent with `crossSiteWarmStart()` in `lib/background-helpers.js` by
  hand, same accepted cost as the rest of `eval/`.
