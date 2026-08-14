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

## Update — redesigned as "free time": grants access instead of blocking

The "take a break" design above — a commitment device that *blocked*
every managed site — was replaced after a real usage report: the only
ways to get genuinely unrestricted access when it was actually needed
were an effortful per-site override (costly by design) or fully disabling
the extension, which corrupts active-time tracking and is exactly what
`STALE_GRANT_THRESHOLD_MIN`/`HEARTBEAT_GAP_THRESHOLD_MIN` exist to detect
and recover from. The request was explicit: free time should mean *free
access*, not another popup asking for a response, and it should exist
specifically to reduce how often either of those costlier escape hatches
gets reached for.

**What changed, mechanically:**

- `startBreak`/`overrideBreak`/`onBreakFollowup` became
  `startFreeTime`/`endFreeTimeNow`/`onFreeTimeFollowup`. Instead of
  `handleRequestAccess`/`CHECK_ACCESS` denying everything during the
  window, `rebuildBlockRules` now skips adding a block rule for *any*
  site while a window is active — gating is suspended at the network
  level, not just refused at the decision layer. A window starting mid-
  grant still finalizes that grant (trains the site bandit normally on
  real usage), and two alarms are scheduled: a fixed-name
  `freeTimeExpire` alarm right at the window's natural end (restores
  gating — rescheduled, not duplicated, if a new window starts before
  the old one ends) and a per-window `freeTimeFollowup:<startedAt>` alarm
  `freeTimeTooShortWindowMin` later, to judge whether the window held up
  once there's been time to tell.
- **Ending early lost all its friction.** The old design's override
  required a flat 45s wait plus an 8s hold, deliberately harder than an
  ordinary per-site override, because breaking a commitment device was
  supposed to cost something. That reasoning doesn't apply to free time:
  choosing to re-enable your own gating early is a disciplined act, not a
  relapse, so `endFreeTimeNow` is a single click from the popup, with no
  wait or hold — `breakOverrideDelaySec`/`breakOverrideHoldMs` and the
  entire override-break UI in `blocked.js`/`blocked.html` were deleted,
  not just hidden. Blocked.html shouldn't even load during a window now
  (DNR isn't blocking), so ending free time no longer has any reason to
  live there.
- **Reward polarity flipped for "ending early."** The old design
  penalized an override, scaled by how early it happened — breaking early
  was *always* a worse outcome. `computeFreeTimeReward`'s `ended_early`
  branch is the opposite: reward scales *up* with `elapsedFrac` and is
  floored at 0, never negative. Ending at 5% elapsed scores low (this
  duration was mostly unused — pick shorter next time); ending at 95%
  scores close to the full bonus (this was close to right-sized). It's
  calibration feedback, not a penalty — the reward function no longer
  treats disciplined early-ending as a failure.
- **The "too short" signal changed what it watches for.** The old
  design's `onBreakFollowup` looked for a `grant` session or another
  break starting in the follow-up window — either meant "you went back to
  a site." For free time, an ordinary bandit-granted session isn't
  friction (that's the system working as intended); the real signal is
  `onFreeTimeFollowup` finding a **denial or an override** (or another
  free-time window starting) in that window — gating actually pushed back
  again, meaning the window ended too soon.
- **The proactive-suggestion trigger changed from time to friction.**
  `globalFatigueStats`'s rolling 24h total-active-minutes still feeds the
  bandit's *context* (still the strongest predictor of how long a window
  should be — unchanged from the original finding). But `shouldSuggest`
  no longer fires off that same number. A new `globalFrictionCount24h`
  (`lib/background-helpers.js`) counts denials and overrides across every
  managed site in the last 24h, and `DEFAULT_FREE_TIME_FRICTION_THRESHOLD`
  (default 3) is what actually triggers the popup's proactive suggestion —
  directly targeting the motivating problem (how often the gate has
  pushed back) rather than a proxy for it (how much time was spent).

**Not independently re-simulated.** `eval/simulate_break.py` still
describes the *original* block-based reward shape and has not been
updated or re-run for the free-time redesign — the new
`computeFreeTimeReward` shape in `lib/config.js` is reasoned from the
same principles the original simulation validated (asymmetric penalties
tied to observable timing, a threshold-triggered proactive suggestion),
not independently measured. `DEFAULT_FREE_TIME_ALPHA` was inherited
as-is from the original break-duration bandit's tuned value rather than
re-derived, on the same "arm count and reward scale didn't change, only
what duration means" reasoning — this is a real gap, not an oversight:
building a `simulate_free_time.py` counterpart is legitimate follow-up
work, not done here per the scope of the session that made this change
(bug fixes and documentation for the current version, not new offline
research).
