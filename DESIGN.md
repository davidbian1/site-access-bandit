# Design decisions

This is about the system itself — why it's built the way it is, not the
engineering-hygiene pass that touched file structure/tests/tooling.

Every claim below is grounded in something actually documented in the
README or in a code comment; where the "why" behind a decision isn't
written down anywhere, it's marked **not documented** rather than guessed
at. Some of those still need your answer.

## Why a contextual bandit at all

**Not documented.** The README explains *what* the bandit does (decides
grant/deny/duration per visit, learns from actual active time), but
nowhere explains why this problem called for a bandit specifically
rather than, say, a fixed per-time-of-day schedule, a simple rule engine,
or manual quotas. If you remember the reasoning — worth adding here.

## Why LinUCB, specifically

`lib/linucb.js` implements disjoint LinUCB (Li et al., 2010): each arm
keeps its own ridge-regression state (`A`, `b`), scored as
`theta^T x + alpha * sqrt(x^T A^-1 x)` — a linear reward estimate plus an
uncertainty bonus that shrinks as an arm gets more data in a given
context.

What that buys, generically: it handles a continuous context (time of
day, recent usage) without discretizing it into buckets, and the UCB term
gives principled explore/exploit — the bandit tries an arm more in
contexts it's less certain about, not at random.

**Not documented:** why LinUCB over alternatives (epsilon-greedy,
Thompson Sampling, a non-linear bandit). It's a reasonable, standard
choice for a low-dimensional linear-ish problem like this one, but I
don't have evidence that other options were weighed and rejected — that
comparison isn't in the repo.

## Why a separate model per site (disjoint across sites, not just across arms)

Each managed site gets its own independent `LinUCB` instance — the
README lists this explicitly, but under **"Known limitations (MVP
scope)"**, not as a permanent design principle: *"Each managed site gets
its own independent bandit model (no sharing of learned weights across
sites)."*

That framing matters: it reads as a scope cut for v0.1, not a considered
rejection of shared weights. **Not documented:** whether a shared/hybrid
model (e.g. site identity as a feature, or a warm-start from other sites'
weights) was considered and rejected, or just deferred.

## Context vector design — cyclical time encoding + recent-usage stats

`buildContext()` in `lib/config.js` builds a 7-dimensional vector: a bias
term, `sin`/`cos` of hour-of-day, `sin`/`cos` of day-of-week, a
normalized 24h session count, and a normalized recent-average-active-
minutes figure.

The `sin`/`cos` pair for hour and day-of-week is a standard technique for
encoding periodic features into a linear model — it's not project-
specific reasoning, it's a well-known fix for the discontinuity a raw
hour value has (23:00 and 00:00 are adjacent in real time but far apart
as plain numbers; the linear model would have no way to know that
without this).

**Not documented:** why these two particular behavioral features
(24h session count, 5-session rolling average active time) rather than
others — e.g. a longer-horizon trend, days-since-last-visit, or a
site-category signal.

## Reward function — access is never positive, only avoiding it is

Fully documented, in the README's "Reward function" section and in
`lib/config.js`'s comments — no blanks here:

- A denial that stands (never overridden) gets a flat positive reward
  (`denyReward`, default 0.15).
- Any granted session — whether from a normal decision or from
  overriding a denial — is only ever a penalty: scaled by active minutes,
  plus a frequency penalty for repeat visits within a window (so a binge
  of many short visits can't each score near-zero the way one would),
  plus an extra flat penalty if it came from an override. Clamped to
  `[-1, 0]`.

The explicitly stated intent (from the README, verbatim in spirit): the
bandit's baseline preference is always toward denying — a grant arm can
only ever "lose less" in a given context, never accumulate a positive
score of its own. Access has to be earned back per-context by costing
less, not by being rewarded.

## Per-navigation re-gating (no implicit free-roam window)

Documented behavior, with reasoning given: a grant covers exactly the
page it was requested for. `content-main.js` patches the page's real
`pushState`/`replaceState` (in the page's own MAIN world, since an
isolated-world patch never sees calls the page's own script makes) and
rebroadcasts them; `content.js` uses that to end the current grant the
moment the URL changes, so every new video/post/page gets its own fresh
decision. The stated reasoning: duration-based limits are meaningless if
navigating to the *next* thing is free.

## Grace credits — override grace is generous, extend grace is scarce

Both are documented with explicit reasoning, and the asymmetry between
them is deliberate, not accidental:

- **Override grace** (after successfully overriding a denial): hop count
  generous enough to feel like free browsing for the window's duration.
  Reasoning given: the effort of getting through the wait-and-hold should
  buy more than the one page it was spent on, or the mechanism is
  pointless.
- **Extend grace** (after an extremely long session, offered once): hop
  count of 1 by default — deliberately scarce. Reasoning given: this
  isn't correcting a wrongful denial the way override is; it's a narrow,
  single-use exception for a session that already ran unusually long.

## Trust decay — half-life instead of a hard expiry

Documented reasoning: a flat grace window is fine for "let me finish what
I was doing," but effort spent on an override shouldn't evaporate the
instant that window lapses. Trust decays smoothly on a half-life
(default 90 min) instead of snapping to zero at a cutoff, so coming back
to a site soon after is still somewhat easier, fading gradually rather
than falling off a cliff.

## Adaptive cooldown instead of a fixed number

Documented reasoning: a fixed cooldown only ever gets easier to click
through the more you use the extension, regardless of whether your
actual usage has been getting heavier or lighter. Cooldown is instead
computed from the same recent-active-time stat the bandit's context
already tracks, so it drifts toward the floor after brief recent
sessions and toward the ceiling after long ones.

## Long-form dwell (automatic) vs. extreme long-form extend (effort-gated)

Documented distinction, with reasoning given for why these are treated
differently: staying on the *same* page past its timer gets one
automatic, effort-free exception (a silent re-draw if you're still
actively watching and already dwelled past a threshold) — described as
the only automatic exception anywhere in the system. Navigating to a
*new* page always hits the gate; the only way past it is the effort-
gated extend offer, and only after an extreme (well past long-form)
session. The stated reasoning: staying put isn't really "one more site
to gate," but navigating to something new always is, by design.

## Open — not documented anywhere, needs your answer if you want it captured

- Why a bandit-based approach over a simpler mechanism (fixed schedule,
  static rules, manual-only overrides)?
- Why LinUCB specifically over other bandit algorithms?
- Why disjoint per-site models rather than a shared/hybrid one — a
  deliberate rejection, or just out of scope for v0.1?
- Why these particular default magnitudes (`alpha = 1.0`,
  `denyReward = 0.15`, `denyOverridePenalty = 0.4`,
  `penaltyPerMinute = 1/30`, etc.)? They're documented as *what* they do
  and are editable in settings, but not why these specific starting
  values versus others.
