# Design decisions

This is about the system itself — why it's built the way it is, not the
engineering-hygiene pass that touched file structure/tests/tooling.

Every claim below is grounded in something actually documented in the
README or in a code comment. Where the "why" behind a decision isn't
written down anywhere, it's marked **not documented** rather than
guessed at.

## Why a contextual bandit at all

**Not documented.** The README explains *what* the bandit does (decides
grant/deny/duration per visit, learns from actual active time), but
nowhere explains why this problem called for a bandit specifically
rather than, say, a fixed per-time-of-day schedule, a simple rule engine,
or manual quotas.

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
choice for a low-dimensional linear-ish problem like this one, but
there's no record in the repo of other options being weighed and
rejected.

## Why a separate model per site (disjoint across sites, not just across arms)

Each managed site gets its own independent `LinUCB` instance — listed
explicitly under [Known limitations](#known-limitations-mvp-scope)
below, not framed as a permanent design principle.

That framing matters: it reads as a scope cut for v0.1, not a considered
rejection of shared weights. **Not documented:** whether a shared/hybrid
model (e.g. site identity as a feature, or a warm-start from other sites'
weights) was considered and rejected, or just deferred.

## Discount factor — adapting when the bandit's own decisions change behavior

Added deliberately, with a clear reason (unlike most of the sections
above, this one isn't reconstructed after the fact — it's documented as
it was decided): vanilla LinUCB accumulates `A`/`b` forever, so a data
point matters exactly as much a year later as it did the day it
happened. That's a reasonable assumption if the environment is
stationary, but it isn't necessarily here — the bandit's own decisions
are part of what shapes future behavior around a site. A run of denials
at some hour might genuinely change when access gets requested again; a
run of grants might change how often it does. This isn't adversarial
gaming of the model — it's the ordinary feedback loop of a tool that
intervenes in behavior and then keeps learning from the behavior it
already influenced. A model that never forgets can't track a shift like
that; it stays anchored to however things looked before the shift, for
as long as that older data keeps outweighing the new.

`LinUCBArm.update()` (`lib/linucb.js`) now discounts each arm's `A` and
`b` by `gamma` before folding in a new observation:

```
A = gamma * A + (1 - gamma) * I + x xᵀ
b = gamma * b + x * reward
```

The `(1 - gamma) * I` term matters: without it, the ridge regularization
from the initial identity matrix would decay away along with the
discounted data, risking a poorly-conditioned `A` after enough rounds.
Re-adding it every step means the regularization settles at a steady
state of exactly `I` instead of vanishing, so `A` stays safely
invertible no matter how long the bandit runs.

`discountFactor` (default 0.99, editable on the options page) gives an
effective memory of roughly `1/(1-gamma) ≈ 100` observations — long
enough that ordinary day-to-day noise doesn't dominate the estimate,
short enough that a real, sustained change in behavior shows up within
weeks of typical use rather than months. `gamma = 1.0` disables
discounting entirely and reproduces the original, undiscounted behavior
exactly (verified in `lib/linucb.test.js`).

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

Fully documented in `lib/config.js`'s comments — no blanks here.

A denial that stands (never overridden):

```
reward = denyReward   (default 0.15)
```

A granted session — whether from a normal decision or from overriding a
denial:

```
reward = - activeMinutes * penaltyPerMinute
         - min(maxFrequencyPenalty, recentSessionCount * frequencyPenaltyPerSession)
         - (wasOverride ? overrideSessionPenalty : 0)
```

clamped to `[-1, 0]`. `recentSessionCount` is how many other sessions on
this site already landed within the last `frequencyWindowMin` (default
30 min) — without it, a string of short visits would each score close to
0 (the best a grant can score) and the bandit would read that as "fine
to keep allowing"; the frequency term makes repeat visits chip away at
the reward regardless of how short each one was individually.

If the session came from an override, `overrideSessionPenalty` (default
0.3) applies on top — separate from, and in addition to,
`denyOverridePenalty` (default 0.4, see below), which retroactively
flips the *original* deny decision's reward from positive to negative.
Together an override costs twice: once on the decision it overrode, once
on the session it produced.

Defaults: `penaltyPerMinute = 1/30` (30 active minutes ≈ -1),
`denyReward = 0.15`, `overrideSessionPenalty = 0.3`,
`frequencyPenaltyPerSession = 0.1`, `maxFrequencyPenalty = 1.0`. All
editable on the options page, along with `alpha` and the arm durations.

The stated intent: the bandit's baseline preference is always toward
denying — a grant arm can only ever "lose less" in a given context,
never accumulate a positive score of its own. Access has to be earned
back per-context by costing less, not by being rewarded.

## Data integrity — not training on a session with a monitoring gap

Also added deliberately, for the same reason discounting was: bad
training data is worse than no training data. Active-time tracking
depends entirely on the service worker actually running — a
`chrome.alarms` tick every 30 seconds while a grant is active. If the
extension is disabled mid-grant, tracking stops immediately and the site
becomes completely unrestricted for as long as it stays disabled, but
`grant.activeSeconds` freezes at whatever it was the moment tracking
stopped. Whenever that grant eventually gets finalized, computing a
reward from that frozen number would understate real usage and feed the
model an artificially lenient signal for that context — training it,
in effect, on a number that was never true.

`isGrantStale()` (`lib/background-helpers.js`) flags a grant discovered
more than `STALE_GRANT_THRESHOLD_MIN` (5 min) past its own `expiresAt` —
alarms can legitimately run a little late under normal operation, but
landing minutes past deadline means the service worker plainly wasn't
running to catch it on time. `finalizeSession()` checks this before
touching the bandit: a stale session is still logged, visibly marked in
the options page's session history, but excluded from the reward update
entirely rather than trained on with a number known to be wrong.
`handleRequestAccess()` also checks for a stale grant before treating an
existing one as still active — otherwise a grant whose expire alarm was
missed entirely (not just late, but never delivered) would leave that
site stuck in "already granted" indefinitely, with the bandit never
getting to decide for it again.

## Per-navigation re-gating (no implicit free-roam window)

Documented behavior, with reasoning given: a grant covers exactly the
page it was requested for. `content-main.js` patches the page's real
`pushState`/`replaceState` (in the page's own MAIN world, since an
isolated-world patch never sees calls the page's own script makes) and
rebroadcasts them; `content.js` uses that to end the current grant the
moment the URL changes, so every new video/post/page gets its own fresh
decision. The stated reasoning: duration-based limits are meaningless if
navigating to the *next* thing is free.

## Override wait — grows with abuse, shrinks with demonstrated patience

Getting the "I really need this" button to even become pressable takes a
wait computed as:

```
overrideDelaySec = clamp(
  overrideBaseDelaySec + overrideDelayRampSec * recentOverrideCount
                        - overrideEffortDiscountSec * denyStreak,
  0, overrideMaxDelaySec
)
```

Defaults: base 20 sec, +60 sec per override already used on this site in
the last 4 hours (`overrideWindowMin`), -8 sec per consecutive genuine
denial you've patiently gone through the normal ask-and-wait flow for
since your last grant or override (`recentDenyStreak`) — floors at 0
(instant), ceilings at 600 sec. Once enabled it still needs a sustained
3-second press-and-hold (`overrideHoldMs`), not a click.

## Grace credits — override grace is generous, extend grace is scarce

Both bank a credit consumed via `consumeGrace()` in `lib/config.js`: each
navigation that spends a hop also halves whatever time was left on the
credit, on top of decrementing the hop counter — so it degrades on two
axes at once and can't be stretched past what it was earned for.

- **Override grace** (after successfully overriding a denial):
  `overrideGraceMin` (default 5 min) and `overrideGraceHopCount`
  (default **50**) — generous enough to feel like free browsing for the
  window's duration. Reasoning given: the effort of the wait-and-hold
  should buy more than the one page it was spent on, or the mechanism is
  pointless.
- **Extend grace** (after an extremely long session, offered once):
  `extendGraceMin` (default 15 min) and `extendHopCount` (default **1**)
  — deliberately scarce. Reasoning given: this isn't correcting a
  wrongful denial the way override is; it's a narrow, single-use
  exception for a session that already ran unusually long.

## Trust decay — half-life instead of a hard expiry

A per-site trust value (0–1) is bumped by `trustOverrideBoost` (default
0.6, capped at 1) on a successful override, and decays exponentially with
`trustHalfLifeMin` (default 90 min) rather than expiring outright.
Whatever hasn't decayed away discounts both the retry cooldown and the
override wait, up to `trustMaxDiscount` (default 70%) at full trust.

Documented reasoning: a flat grace window is fine for "let me finish what
I was doing," but effort spent on an override shouldn't evaporate the
instant that window lapses — trust lets the benefit fade smoothly
instead of snapping to zero at a cutoff.

## Adaptive cooldown instead of a fixed number

```
cooldownSec = clamp(
  minCooldownSec + cooldownRampSecPerMin * avgRecentActiveMin,
  minCooldownSec, maxCooldownSec
)
```

Defaults: floor 5 sec, ceiling 120 sec, ramp 8 sec per minute of recent
average active time. Documented reasoning: a fixed cooldown only ever
gets easier to click through the more you use the extension, regardless
of whether your actual usage has been getting heavier or lighter — this
keeps the friction tied to actual recent behavior instead. It does *not*
currently escalate with repeated skip-cooldown use the way override and
extend do — a straightforward "spend a moment of effort instead of
watching a clock" release valve rather than another abuse ramp. Whether
it needs one is an open question, not a decision either way.

## Long-form dwell (automatic) vs. extreme long-form extend (effort-gated)

Two thresholds, treated deliberately differently:

- `longFormDwellMin` (default 8 min): if you're still actively watching
  when a grant's timer runs out and you'd already dwelled this long, the
  extension silently re-asks the bandit with the current context instead
  of hard-cutting you — the only automatic, effort-free exception
  anywhere in the system, and it only ever applies to staying on the
  *same* page. The actual threshold used is `min(longFormDwellMin,
  grant.durationMin)`, not the flat 8 minutes alone — otherwise the
  shortest arm (5 min, below the 8-minute default) could never reach the
  floor before its own grant expired, making it structurally exempt from
  this protection no matter how attentively it was used. Fully using a
  short grant is itself a genuine engagement signal, just like fully
  using a long one is.
- `extremeLongFormMin` (default 45 min): if a session you're navigating
  *away* from ran this long, the blocked page you land on offers
  "Continue watching" for `extendOfferWindowMin` (default 2 min) before
  the offer lapses — the effort-gated extend mechanic above.

Stated reasoning for the split: staying put isn't really "one more site
to gate," but navigating to something new always is, by design — the
extreme-session exception exists because that's still a strong enough
signal to be worth a narrow, effortful escape hatch.

## Code layout

- `manifest.json` — MV3 manifest (`declarativeNetRequest`, `alarms`,
  `tabs`, `scripting`, `storage`; host permissions requested per-site via
  the optional permissions API, not baked in up front).
- `background.js` — service worker: decision logic, DNR rule management,
  dynamic content-script (re)registration per managed site, active-time
  tracking, session finalization, messaging API for the UI pages and
  content script.
- `content-main.js` — registered in the page's own MAIN world (not the
  extension's isolated world) on every managed site. Patches
  `history.pushState`/`replaceState` so client-side route changes are
  actually seen — an isolated-world override only patches a copy the
  page's own script never calls. Rebroadcasts every navigation as a DOM
  event.
- `content.js` — isolated world (has `chrome.*` API access); listens for
  `content-main.js`'s event and ends the current grant, forcing a fresh
  decision for the new destination.
- `lib/linucb.js` — the LinUCB bandit implementation (plain JS, no deps).
- `lib/config.js` — shared constants, context-feature builder, reward
  function.
- `lib/background-helpers.js` — `background.js`'s pure helpers
  (recent-usage window stats, grant construction, DNR rule-id
  bookkeeping), split out so they're unit-testable without a `chrome.*`
  mock.
- `blocked.html` / `blocked.js` — the page shown instead of a blocked
  site.
- `popup.html` / `popup.js` — quick add/remove sites, see/end the active
  grant for the current tab's site.
- `options.html` / `options.js` — full site list, bandit/reward
  parameters, per-site bandit debug view, session history.

`lib/*.test.js` covers the bandit math and the reward/cooldown/trust/
override calculations via Node's built-in `node:test` runner. There's no
automated coverage of the browser-integration pieces (`background.js`'s
`chrome.*`-driven logic, `content.js`/`content-main.js`, the DNR rules) —
those need manual verification in an actual loaded extension.

## Development

Requires Node 18+ — only for running tests and linting. The extension
itself has zero runtime dependencies and no build step; `Load unpacked`
runs the source files directly.

```
npm install
npm test
npm run lint
```

`npm run lint` runs ESLint (`eslint.config.js`) over the whole repo —
its one job is catching real mistakes (unused variables, references to
undeclared globals), not enforcing a formatting style. Both commands run
in CI on every push and PR.

## Known limitations (MVP scope)

- Blocking only covers top-level (`main_frame`) navigations, not iframes.
- Active-time tracking samples on a timer (default every 30s) rather than
  listening to every focus/visibility event, so it's an approximation.
- Each managed site gets its own independent bandit model (no sharing of
  learned weights across sites).
- `content.js` re-checks the current URL every 300ms as a fallback, on
  top of the `pushState`/`replaceState`/`popstate` hooks, to catch
  client-side routing that doesn't go through any of those three. This is
  a deliberate trade-off, not an oversight: it costs a small, constant
  amount of CPU on every open tab of a managed site for as long as that
  tab stays open, in exchange for not missing navigations the real hooks
  can't see.

## Open questions — rationale not documented anywhere in the repo

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
