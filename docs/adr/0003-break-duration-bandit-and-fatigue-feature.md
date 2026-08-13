# 0003. A learned break-duration bandit, and a rejected cross-site fatigue feature

## Status

Accepted and implemented (break-duration bandit) / Rejected (cross-site
fatigue as a site-bandit context feature) — based on simulation, not real
usage data. See Consequences and the Update below.

## Context

Two proposals came up in discussion, both aimed at "what would help the
bandit learn better":

1. "Take a break" currently takes a fixed, user-typed duration. Should a
   bandit learn a good default instead — and if so, what reward could it
   possibly learn from, given the whole point of the feature is to *avoid*
   adding a "rate this break" prompt?
2. The per-site bandit's context has no signal for "how much time has
   already gone to *other* managed sites today" — only its own recent
   history. Binge behavior plausibly isn't confined to one site. Would
   adding that as a context feature help?

Neither could be answered by reading the code — both needed to actually be
simulated, same discipline as
[0001](0001-reward-shaping-and-eval-harness.md) and
[0002](0002-recency-feature-and-cross-site-warm-start.md). Two new modules,
`eval/simulate_break.py` and `eval/simulate_fatigue.py`, were built to do
that. Both are illustrative synthetic environments, not fit to real
behavioral data — same honest-scope caveat as every other `eval/simulate_*`
module.

## Decision

### 1. Break-duration bandit — adopted and implemented

`eval/simulate_break.py` models a latent "actually needed" break length
`T`, drawn each round from a distribution centered on a context-dependent
ideal `D*(hour, fatigue)`. The reward is inferred from what happens to a
chosen duration `d`, not from an explicit rating:

- `d <= T` (break wasn't long enough): completion bonus minus a penalty
  scaled by the shortfall.
- `d > T` and overridden before it ends: penalty scaled by how *early* the
  override happened (breaking at minute 2 of a 60-minute break is worse
  than breaking at minute 55).
- `d > T` and not overridden: completion bonus minus a small per-minute
  cost for the wasted excess.

**This reward shape is learnable, not degenerate.** Over 5 seeds at a
tuned alpha (~0.08–0.3, found by sweeping — see below), arm selection
concentrated on the middling durations (30/45/60 min) rather than
collapsing to the shortest or longest arm, and the gap between the chosen
duration and the (unobserved) ideal shrank from an early-vs-late average of
roughly 18–23 min down to 14–16 min across 400 rounds. The policy also
converged with a small systematic bias toward *slightly* shorter durations
(mean signed gap ≈ −8 min) — directly explained by the reward shape itself:
overriding early is penalized harder (`override_penalty=1.0`) than falling
short (`too_short_penalty=0.6`), so a bandit that's absorbed enough data
learns to hedge toward the less-punished failure mode. That's a sensible,
explainable equilibrium, not a bug.

**Alpha needs its own calibration — the site bandit's tuned value doesn't
transfer.** The site bandit's ADR 0001-tuned alpha (≈0.05) was found for a
narrower reward range (`[-1, 0.15]`) and 4 arms; this bandit's reward range
is wider (`[-1, 0.5]`) with 7 arms spanning a much longer duration axis. A
fresh sweep found shipped `alpha=1.0` produces roughly 45% more regret
(53.8) than a properly tuned value (36–41 in the 0.08–0.3 range) — a real,
meaningful gap, though nowhere near the 80x found for the site bandit in
0001. **Do not reuse `DEFAULT_ALPHA` for this bandit if it ships** — it
needs its own default, ideally re-tuned against real break-taking data
once there's enough of it, same "don't ship a synthetic optimum as a real
default" caveat as 0001.

**The fatigue context feature earns its place here.** Blinding this
bandit's own fatigue signal (forcing it to always see a constant instead
of the real value, while the true ideal duration still depends on it)
raised regret by roughly 30–40% (e.g. 36.2 → 55.7 at alpha=0.08) — a
large, consistent effect across the alpha values tested. Unlike the
cross-site experiment below, fatigue here is the single largest driver of
the ground truth (a 70-point swing out of a ~120-point range), not one
modifier among several — which is the likely reason it helps clearly in
one setting and not the other. See "Open question" below for what "fatigue"
should concretely be computed from in the real extension.

### 2. Cross-site "total time today" as a site-bandit context feature — rejected

`eval/simulate_fatigue.py` runs several independent per-site bandits
sharing one clock and one running cross-site daily total. True per-grant
risk is the existing `risk_for()` (hour/frequency/recent-usage — today's
real drivers) plus `fatigue_coupling * (today's cross-site total,
normalized)`. Two conditions were compared at matched settings: today's
real 7-dimensional context vs. an 8-dimensional one with the cross-site
total appended.

**The feature did not clearly help, across the alpha range tested.** At
shipped `alpha=1.0`, adding it consistently made regret slightly *worse*
(e.g. 54.8 → 57.9 at the strongest tested coupling, 0.5) — the extra
dimension's cost (a bigger identity matrix to regularize, more UCB
uncertainty early on) outweighed whatever signal it added, at this
project's realistic data volume (300–600 rounds). A full alpha sweep at
the strongest coupling found the feature turn from a net negative,
crossed a narrow band (alpha ≈ 0.15–0.2) where it was a small net positive
(≈5–7%), then back to negative. And at `alpha≈0.05` (0001's
synthetically-tuned value), the two conditions produced *identical*
results to many decimal places — because at that alpha the model has
already collapsed to near-always-deny regardless of context (0001's own
finding), so no context feature, old or new, can matter at that operating
point. There is no alpha value tested at which this feature was a clear,
robust win.

**Rejected as a site-bandit context feature, same treatment as the
recency feature in 0002** — not implemented, not defaulted on, but the
simulation and reasoning are kept here for the record in case real usage
data later suggests otherwise. The likely reason it worked for the
break-duration bandit but not here: fatigue there was the dominant driver
of the ground truth; here it's one modifier layered onto an
already-multi-factor risk model dominated by time-of-day and per-site
frequency, and the marginal signal it adds isn't worth its parameter cost
at this data volume.

## Consequences

- **The cross-site fatigue feature is not being added to the per-site
  bandit's context**, based on this evidence. This is a simulated,
  illustrative result, not a permanent verdict — if real exported session
  data later shows binge behavior clearly spanning multiple sites in a way
  the per-site context misses, this decision should be revisited against
  that data, not against this synthetic environment.
- **The break-duration bandit needed its own alpha default** — it does
  not inherit `DEFAULT_ALPHA` or the 0001-tuned value from the site
  bandit; see the Update below for what shipped.
- **The two Python simulation modules must be kept in sync with the JS
  reward/context logic by hand**, same accepted maintenance cost as every
  other `eval/simulate_*` module (see 0001's Consequences).

## Update — break-duration bandit implemented

The design above shipped in the live extension:

- `getBreakBandit` (`lib/background-helpers.js`) — a single global
  `LinUCB` instance, arms fixed at `BREAK_DURATIONS_MIN`
  (`lib/config.js`). `eligibleBreakArmIndices` filters which arms can be
  suggested/selected against the current `breakMaxMin`, without resizing
  the bandit itself — the "open question" above (calendar-day vs. rolling
  24h) was resolved in favor of a rolling 24h window
  (`globalFatigueStats`), since it needed no arbitrary day-boundary
  discretization and was already the simplest thing to compute from
  existing session timestamps.
- `computeBreakReward` (`lib/config.js`) is the real (non-simulated)
  counterpart to `sample_break_reward_batch` — no latent "actually
  needed" duration to sample in reality, only what was actually observed:
  overridden (immediate), too-soon-after (detected by
  `onBreakFollowup`, an alarm scheduled `breakTooSoonWindowMin` past the
  break's end that scans real session/break timestamps in that window),
  or a clean completion.
- `DEFAULT_BREAK_ALPHA = 0.15` shipped as the deliberately conservative
  choice flagged as needed above — the middle of the 0.08–0.3 range this
  ADR's simulation found performed similarly well, not the single best
  value found.
- The popup UI has no minutes input at all: `GET_BREAK_SUGGESTION`
  returns the bandit's top pick plus its two nearest eligible duration
  neighbors as chips, surfaced automatically once
  `globalFatigueStats`'s rolling 24h total crosses
  `breakEffortThresholdMin` (throttled by `breakSuggestCooldownMin`), or
  on demand via a small link otherwise.

See DESIGN.md's "Take a break" section for the full mechanism description.
