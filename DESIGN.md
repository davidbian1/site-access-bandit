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

Each managed site still trains its own independent `LinUCB` instance —
listed explicitly under [Known limitations](#known-limitations-mvp-scope)
below, not framed as a permanent design principle. That framing turned out
to matter: it read as a scope cut for v0.1, not a considered rejection of
shared weights, and a later pass (below) picked it back up rather than
leaving it as a permanently unexamined gap.

**Not documented:** whether a *full* shared/hybrid model (the paper this
implements, Li et al. 2010, defines one) was ever considered and rejected
for v0.1, or just deferred. What follows is a narrower fix — one-time
warm-starting a new site, not ongoing weight sharing — tested rather than
assumed; see the Open questions section for what's still unaddressed
beyond it.

## Cross-site warm-start — a new site doesn't have to start from nothing

Added deliberately, and tested in `eval/` before shipping (docs/adr/0002)
rather than assumed to help: a brand-new managed site used to start with
`A=I`, `b=0` — pure ignorance — even when other managed sites already had
plenty of learned data. `crossSiteWarmStart()` in
`lib/background-helpers.js` initializes a new site instead from a
shrinkage-weighted average of other sites' *learned* contribution (each
sibling's `A` minus its own identity baseline, so a site with more data
doesn't also inject more regularization than a fresh site should start
with):

```
A = I + shrinkage * mean(sibling.A - I)
b = shrinkage * mean(sibling.b)
```

`crossSiteWarmStartWeight` (default 0.2, editable, 0 fully disables it —
reproducing the original per-site-independent behavior exactly) applies
whenever a site has no valid saved state of its own, including a first-ever
decision or a dimension/arm-count mismatch after a settings change.

The simulation behind this found something worth being honest about:
warm-starting reduced regret at every shrinkage tested, *including* from
deliberately dissimilar or fully adversarial (inverted-risk) sibling
sites — surprising enough that it was stress-tested rather than trusted.
The working explanation, not confirmed directly: today's reward ceiling
(see below) makes denying close to correct almost everywhere, so nearly
any confident prior speeds convergence toward that reward-dominant policy,
regardless of whether the specific thing borrowed is accurate. That also
means this finding is coupled to the current reward shape — see ADR 0002
for what changed when the ceiling was relaxed experimentally.

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
(24h session count, 5-session rolling average active time) were the
original choice rather than others — e.g. a longer-horizon trend or a
site-category signal.

One candidate addition — an 8th "hours since last visit" dimension — was
tested rather than left as a documented gap. `eval/simulate_recency.py`
ran a bandit that could see it against one that couldn't, against an
identical ground truth deliberately built so recency carries a real signal
independent of the two features already present. Result: no reliable
benefit (differences under ~1%, direction flipped between a 5-seed and a
20-seed run of the same setup — noise, not signal) — see docs/adr/0002 for
the numbers and a working theory for why. `FEATURE_DIM` stays 7. This was
a genuine test with a negative result, not a decision to defer.

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

**Grant scope is enforced by sub-URL identity, not just hostname.** DNR's
block rule and the registered content scripts both have to be
hostname-wide — that's the only granularity a `matches` pattern supports —
so without a further check, *any* page on a granted hostname would read
as covered for as long as some grant exists anywhere on that site: a
fresh tab to a different video while one grant is active would sail
through untouched, since DNR isn't even blocking that hostname at all
while a grant exists. `isSameSubUrl` (`lib/config.js`) closes this —
`CHECK_ACCESS` requires the current URL's origin, pathname, and query
string to match the grant's own `targetUrl`; only the hash fragment is
ignored (scroll anchors, in-page state — never a distinct piece of
content). The query string is deliberately *not* ignored in general,
matching the same reasoning behind content.js's navigation debounce: some
sites encode content identity there (`?v=VIDEO_ID` on a shared `/watch`
path), so stripping it would make every video on a site with that
pattern read as "the same page."

**A fresh grant's first real navigation gets one free hop before that
lock-in applies** (not to be confused with the *grace* credit's hops,
below — a different mechanism entirely). `targetUrl` is whatever page you
were actually blocked on when you requested access, which is often a
general entry point (a homepage, a search/listing page) rather than the
specific content you meant to reach — clicking from there into an actual
video is a different sub-URL by `isSameSubUrl`'s own definition. Without
an exception, that first click — the very next thing you'd naturally do
right after being granted access — would immediately fail the check
above and get re-gated, which defeats the point of granting access at
all. `makeGrant`'s `hopUsed` flag (`lib/background-helpers.js`) starts
`false`; the first consuming `CHECK_ACCESS` call that doesn't match
`targetUrl` is let through anyway, `hopUsed` flips to `true`, and
`targetUrl` updates to wherever that navigation landed — from then on,
*that's* the one sub-URL this grant covers, enforced exactly as strictly
as before. Only the consuming (real-navigation) path can spend this hop;
the non-consuming initial-page-load peek never does, so a fresh tab or
page load to a different sub-URL still needs its own decision regardless
of whether the hop's been spent — that's the original fresh-tab gap
above, which this doesn't reopen.

Known imprecision, stated plainly rather than glossed over: if a grant is
requested directly on already-specific content (a direct link to one
video, not a general entry point), the first-hop allowance still exists
and would let exactly one *further* navigation through before locking —
slightly more than "one sub-URL" in that specific case. Distinguishing
"was the original target a general entry point or already-specific
content" would need fragile, site-specific heuristics this project
deliberately avoids elsewhere (see the identity-subdomain section's own
disclaimer); erring toward occasionally-too-lenient was the deliberate
choice over reintroducing the original bug this exists to fix.

This overall asymmetry is intentional, not incidental: staying on the
one covered sub-URL is treated as leniently as possible (see the section
below); navigating to any *other* one — even within the same hostname,
even via a fresh tab rather than an in-page navigation, and after the
one free hop is spent — is treated as a genuinely new decision by
default. Interrupting mid-page is more likely to cut off real
engagement; interrupting right after a redirect is more likely to catch
exactly the kind of one-thing-leads-to-another drift the whole gate
exists for. Grace credits (below) are the one deliberate, *earned*
exception to the second half of that — a plain same-sub-URL grant and a
grace credit are independent ways to pass, so `CHECK_ACCESS` checks the
grant (including the possible free-hop spend) first and only touches
banked grace when neither already covers the request.

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

## Staying on the granted page (automatic, unbounded) vs. extreme long-form extend (effort-gated)

Two different mechanisms, easy to conflate, kept deliberately distinct:

- **Staying on the exact granted sub-URL, past the grant's own timer**
  (`handleExpiry` in `background.js`): unconditional and automatic — no
  bandit re-ask, no dwell threshold, no cap on how many times it renews.
  As long as the active/focused tab is still showing precisely the page
  the grant was made for (`isSameSubUrl`, above), the timer running out
  just silently pushes `expiresAt` forward by another `durationMin` and
  reschedules the `expire:` alarm. This replaced an earlier design
  (`isLongFormEngaged`, an 8-minute dwell floor) that re-asked the bandit
  on expiry instead — which could still deny, hard-cutting sustained
  viewing anyway. A real report was specific about this: interrupting
  *mid*-page is more likely to be the wrong call (edge cases like long-
  form video are exactly where that costs the most), so until the bandit
  is trained well enough on real data to make that call itself, the
  default doesn't ask — it just doesn't interrupt. The moment the tab
  moves to anything else, or loses focus entirely, this stops applying
  and the session finalizes normally; `CHECK_ACCESS`'s own sub-URL check
  is what actually re-gates a real navigation, immediately and by
  default, with no leniency of its own.
- **Extend, after an extremely long session already ended**
  (`extremeLongFormMin`, default 45 min): if a session you're navigating
  *away* from ran this long, the blocked page you land on next offers
  "Continue watching" for `extendOfferWindowMin` (default 2 min) before
  the offer lapses — a deliberate, effort-gated exception (the same
  wait-and-hold shape as override), not an automatic one, and it's about
  the page you're headed *to*, not the one you stayed on.

The first mechanism is unconditionally lenient about time on one page;
the second is deliberately hard to reach and is about what happens next.
Neither one relaxes the default on navigating somewhere new — that's
still a fresh decision every time, which is the entire point of
per-navigation gating.

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

- `eval/` — a separate Python offline evaluation harness (NumPy port of
  `lib/linucb.js`/`lib/config.js`, a synthetic simulation environment,
  Optuna-based tuning, `pytest` tests) for measuring proposed learning
  changes before shipping them, rather than tuning by feel. Not part of
  the extension itself — a from-scratch port, kept in sync by hand; see
  `docs/adr/0001-reward-shaping-and-eval-harness.md`'s "Tooling
  justification" for why each dependency in `eval/requirements.txt` earned
  its place.
- `docs/adr/` — Nygard-format decision records for changes worth a durable
  "why," starting with the `eval/`-backed ones (`0001`: the reward
  ceiling and alpha miscalibration; `0002`: the recency feature tested and
  rejected, cross-site warm-start tested and shipped; `0003`: a
  break-duration bandit tested and shipped, later redesigned into "free
  time" (see the ADR's Update section and DESIGN.md's "Free time" section),
  plus a cross-site "fatigue" context feature for the *site* bandit tested
  and rejected). `docs/adr/README.md` has the convention for proposing any
  future addition to `eval/`'s toolchain.
- `notebooks/bandit_tuning.ipynb` — executes the `eval/tune.py` sweep and
  renders the regret-curve/reward-variant plots referenced in ADR 0001;
  regenerated (not hand-edited) whenever the numbers change.

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

`eval/`'s Python tests are separate from the extension itself (Python
3.10+, its own `requirements.txt`) and run in their own CI job:

```
pip install -r eval/requirements.txt
pytest eval/ -q
```

## Learning trends and unmonitored-gap reconstruction

Whether the bandit is actually learning your habits over time was, until
now, not observable anywhere in the extension — only individual session
records and current arm scores. Two additions to the options page address
this:

- **Reward trend, per site.** The options page now splits each site's
  logged sessions chronologically into an early half and a recent half and
  shows the average reward for each. Reward already bakes in duration,
  frequency, and override penalties (see `computeGrantReward` above), so a
  rising average is a fairly direct read on "is the bandit choosing arms
  that score better," without being confounded by how much you happened to
  want the site that particular week — unlike a raw total-time-on-site
  number, which conflates the bandit's decisions with your own unrelated
  day-to-day variation in wanting to visit at all.
- **Override rate, same split.** Reward improving while override rate also
  climbs would mean the bandit is scoring well by denying harder and
  forcing you to fight it, not by getting closer to what you'd choose
  anyway — tracking both together catches that failure mode that reward
  alone can't.

**Reconstructing time spent while the extension was disabled.** The
service worker cannot log anything while disabled — it isn't running, full
stop, so there's no possible in-extension record of that window. A
`heartbeat` alarm (`HEARTBEAT_PERIOD_MIN`, default every 5 minutes)
writes a timestamp whenever the extension *is* running; if two heartbeats
are further apart than `HEARTBEAT_GAP_THRESHOLD_MIN` (default 12 minutes —
comfortably past ordinary alarm jitter), something stopped the service
worker from running for a while. The same check also runs immediately at
the top of `background.js` on every service worker start — re-enabling a
disabled extension re-runs that top-level code the same way a fresh
browser launch does, so the gap is detected and reconstructed right away
rather than waiting for the next scheduled heartbeat to happen to land. The most common cause is manually
disabling the extension, though a closed browser or a sleeping computer
look identical from in here — there's no way to tell those apart, and this
doesn't try to.

When a gap is detected, `chrome.history.search` is checked for visits to
each managed hostname during that window (`reconstructGap` in
`background.js`), and a rough exposure estimate is logged as a distinct
session shape (`reconstructed: true`, no `armIndex`/`context`/`reward`) —
visible in the trends table's "Unmonitored est." column, but never fed to
`bandit.update()`, since there's no real arm choice or context vector
behind an estimate like this. The estimate itself
(`estimateExposureMinutes` in `lib/background-helpers.js`) is deliberately
crude: `history.search` only returns each page's last visit time within
the window, not a full visit log, so dwell time is inferred from the
spacing between consecutive visits — closer together reads as one
continuous stretch, capped at `RECONSTRUCTED_VISIT_GAP_CAP_MIN` (default
15) so a single visit followed by a long silence doesn't get credited with
sitting open the whole time. This requires the `history` permission,
added to `manifest.json`.

## Free time

Everything above is reactive from the bandit's side (you show up, it
decides) or an escape hatch you reach for after being denied (override,
extend) — both of which cost real, deliberate effort by design. Free time
is different: a proactive, user-initiated window where gating is
suspended entirely across every managed site, meant as a legitimate,
tracked alternative to the two costlier ways of getting real relief —
reaching for an override repeatedly, or fully disabling the extension
(which corrupts active-time tracking; see `STALE_GRANT_THRESHOLD_MIN`/
`HEARTBEAT_GAP_THRESHOLD_MIN`). This replaced an earlier design that
*blocked* every site instead (a commitment device) — see
`docs/adr/0003-break-duration-bandit-and-fatigue-feature.md`'s Update
section for the full redesign rationale; a real report was that the
commitment-device framing pushed people toward exactly the two escape
hatches it should have made less necessary.

**Gating is suspended at the network level, not just refused-then-un-refused.**
`rebuildBlockRules` skips adding a block rule for *any* managed site while
a free-time window is active, so a fresh top-level navigation never hits
`blocked.html` in the first place — no popup, no click, no decision to
make. `handleRequestAccess`/`CHECK_ACCESS` still check
`store.freeTimeUntil` as a defensive fallback (unconditionally granting,
never denying), but that's a safety net for a race at a window's exact
edge, not the primary mechanism.

**The duration is still a learned bandit decision, not typed in.** A
second, global `LinUCB` instance (`getFreeTimeBandit` in
`lib/background-helpers.js`, `FREE_TIME_DURATIONS_MIN = [10, 20, 30, 45,
60, 90, 120]` in `lib/config.js`) picks the suggested duration the same
way the site bandit picks a grant duration. There is no minutes input
field anywhere in the UI; the popup only ever offers duration *chips*
(the bandit's suggestion plus its two nearest eligible neighbors), and
starting a window is a single click on one of them.

**Context still comes from cross-site "fatigue," not the site bandit's own
context** (`globalFatigueStats` in `lib/background-helpers.js`, rolling up
total active minutes across every managed site in the last 24h) — ADR
0003's simulation found this doesn't clearly help the *per-site* bandit's
context, only this one, where it's a much larger share of what actually
drives the decision.

**Reward is inferred from what actually happened, not an added rating
prompt** (see `computeFreeTimeReward` in `lib/config.js`) — and unlike the
original block-based design, ending a window early is never treated as a
bad outcome:
- **Ended early** (`endFreeTimeNow` in `background.js`, triggered by a
  plain, frictionless "End free time now" click in the popup — no wait,
  no hold): scored by how much of the window was actually used before
  ending it. Ending at 5% elapsed scores low (this duration was mostly
  unused — pick shorter next time); ending at 95% scores close to the
  full bonus (this was close to right-sized). Floored at 0, never
  negative — choosing to re-enable your own gating early is a good
  outcome no matter how soon.
- **Ran its course, but a denial or override happened on any managed
  site (or another free-time window started) within
  `freeTimeTooShortWindowMin` of it ending**: the window wasn't long
  enough. A `freeTimeFollowup:<startedAt>` alarm, scheduled when the
  window starts and fired `freeTimeTooShortWindowMin` after it's due to
  end, scans real session/window-start timestamps for exactly that — if
  it finds one, the reward is penalized, scaled by how soon it happened.
- **Ran its course, no such friction within the window**: a clean
  completion, the full bonus.

This alarm-based, after-the-fact scan (rather than reacting the instant a
denial happens) is deliberate: the window itself is a fixed absolute time
range regardless of when the alarm actually fires, so a late-firing alarm
(extension briefly disabled, computer asleep) delays *when* the window
gets trained, not *what* it gets trained on. A second, fixed-name
`freeTimeExpire` alarm fires right at the window's natural end specifically
to restore gating promptly — rescheduled, not duplicated, if a new window
starts before the previous one's natural end — so sites don't stay
ungated for the full follow-up window after free time was supposed to be
over.

**`freeTimeMaxMin` filters which arms are selectable without resizing the
bandit.** The candidate list itself never changes shape (persisted bandit
state needs a stable arm count); `eligibleFreeTimeArmIndices` filters it
down to arms at or under the current cap at suggestion and selection
time. This is the only real constraint left on free time — an unbounded
window would just be "disable the extension" with extra steps, so
`freeTimeMaxMin` (default 180 minutes) caps a single window's length.
This isn't a punishment mechanism, and — unlike the original design —
there's no separate friction mechanism guarding it either; the cap alone
is what keeps it bounded.

**Surfacing is occasional, and the trigger is friction, not time spent.**
`GET_FREE_TIME_SUGGESTION` returns `shouldSuggest: true` once
`globalFrictionCount24h` (denials and overrides across every managed site
today) crosses `freeTimeFrictionThreshold` (default 3), throttled by
`freeTimeSuggestCooldownMin` so it doesn't nag on every popup open while
friction stays elevated — the popup shows the duration chips automatically
in that case. Otherwise, a small "Free time" link reveals the same chips
on demand, so starting one is never gated on the threshold actually being
crossed. Friction (not total time spent) is the trigger deliberately: it's
the more direct signal for the motivating problem — how often gating has
actually pushed back today — where total time is a better predictor of
how *long* a window should be than of *whether* to offer one right now.

**Not (yet) validated against real usage, and not independently
re-simulated from the original design.** ADR 0003's original simulation
found the reward shape's general asymmetric-penalty structure learnable
and non-degenerate; `DEFAULT_FREE_TIME_ALPHA = 0.15` is inherited as-is
from that finding, not re-derived for the free-time reward shape
specifically. `eval/simulate_break.py` still describes the old block-based
design and hasn't been updated — see the ADR's Update section for why
that's a tracked gap, not an oversight.

## Security model

Reviewed against the [OWASP Secure Coding Practices checklist](https://owasp.org/www-project-secure-coding-practices-quick-reference-guide/stable-en/02-checklist/).
Most of the checklist doesn't apply here — there's no server, no database,
no authentication, no network communication of any kind (everything stays
in `chrome.storage.local`). The categories that do apply:

- **Input validation / unvalidated redirects.** `blocked.html` is listed
  in `web_accessible_resources` with `matches: ["<all_urls>"]` (necessary —
  a managed site can be any domain a user adds, and the extension's own
  redirect rule needs to reach it from there), which means *any* page can
  navigate to it directly with arbitrary query parameters, not just the
  extension's own code. Its `target` parameter — where a grant or override
  redirects back to — was previously used with no validation at all: a
  crafted link like `blocked.html?site=reddit.com&target=https://evil.example/phish`
  would show the extension's own familiar "access limited" UI for a site
  the user actually manages, then silently redirect to an attacker-chosen
  origin the moment access was granted. Fixed by `isTrustedTarget`
  (`lib/config.js`) — `target` is only used if its hostname is the managed
  site itself or a subdomain of it; otherwise it falls back to the site's
  own root. This is the one genuine vulnerability this review found.
- **Output encoding / injection.** No `innerHTML`, `eval`, or
  `document.write` anywhere in the codebase — every dynamic table/list is
  built with `createElement`/`textContent` (see `AUDIT.md`'s roadmap item
  4 for when this was first swept). No content security policy override in
  `manifest.json` either — MV3's strict default (`script-src 'self';
  object-src 'self'`) applies as-is, which is already what a hardened CSP
  looks like for an extension with no remote code.
- **Access control / trust boundaries.** `chrome.runtime.onMessage` is
  only reachable from the extension's own contexts (popup, options,
  blocked page, its own content scripts) — no `externally_connectable` is
  declared, so no other extension or web page can send it messages
  directly. The one boundary an external page *can* reach is exactly the
  one above (a direct URL to a web-accessible extension page), which is
  why that's where the validation had to live.
- **Least privilege (flagged, not yet changed).** `manifest.json` requests
  the blanket `tabs` permission (visibility into every tab's URL/title,
  not just managed sites), used for `chrome.tabs.query`/`tabs.update` in
  `kickOutTabs`/`injectIntoOpenTabs`/`onTick`. Every site the extension
  actually queries or updates already has its own host permission granted
  via `chrome.permissions.request` before it's added to `sites` — Chrome's
  documented permission model suggests `tabs.query`/`tabs.update` already
  work for a URL the extension holds host permission for, without needing
  the separate `tabs` permission on top, which would make the blanket grant
  broader than what's actually used. Not changed here: `onTick`'s
  active-tab check runs off a background alarm with no user gesture, which
  rules out substituting the narrower `activeTab` permission for it, and
  removing `tabs` outright without live-testing whether `tabs.update` on a
  background (non-active) tab still works under host-permission-only
  access risks silently breaking active-time tracking — a core input to
  the reward function. See `ROADMAP.md` for this as a tracked, verify-then-fix
  item rather than something to change blind.

## Identity-subdomain exemption

Subdomains of a managed site are gated the same as the site itself by
default (`m.youtube.com`, `music.youtube.com`, etc. are all covered by one
rule) — necessary for the block to actually cover the site, but it swept up
something that isn't really "the site" at all: signing into a managed
site's account commonly bounces the top-level frame through a dedicated
identity subdomain — Google's own sign-in flow from YouTube round-trips
through `accounts.youtube.com`, a real subdomain that exists purely to sync
the account session, not to serve content. Gating that hop interrupted
sign-in itself: the redirect got diverted to `blocked.html` mid-handshake,
found from a real report of the extension's blocked page appearing while
signing into a Google account with only YouTube managed.

`AUTH_SUBDOMAIN_PREFIXES` in `lib/config.js` (`accounts`, `login`,
`signin`, `auth`, `sso`, `id`) is exempted at every enforcement layer:

- A higher-priority `allow` rule in `rebuildBlockRules` (DNR's
  `regexFilter` runs on RE2, which has no negative lookahead, so this has
  to be a second, explicitly-allowed rule rather than an exclusion baked
  into the redirect rule's own pattern).
- `excludeMatches` on both content script registrations in
  `rebuildContentScripts`, so per-navigation enforcement never starts on a
  sign-in hop in the first place.
- `injectIntoOpenTabs` and `kickOutTabs` both skip tabs already sitting on
  one of these subdomains, for the same reason.

This is a heuristic, not an exhaustive list — a false negative here (some
site's actual content living under one of these prefixes) just means that
one subdomain goes ungated, a much smaller cost than routinely breaking
authentication for every managed site.

## Reconciling already-open tabs on re-enable (and every service worker start)

Registering a content script only ever affects *future* navigations — a
tab that was already open and rendered on a managed site when the
extension got disabled has no way to notice it's been re-enabled on its
own. It might never navigate again (a video left playing in the same tab
indefinitely is exactly the case that matters most), so waiting for the
next navigation to fix things could mean never. Found from a real report:
re-enabling only affected tabs opened *after* the fact, not ones that
were already open through the disable/enable cycle.

There is no reliable "I was just re-enabled" signal available to a
service worker — a cold start looks the same whether it's caused by
re-enabling the extension, the computer waking from sleep, or ordinary
MV3 idle unloading, and none of those differ observably from the
extension's own code. Rather than trying to infer the cause,
`reconcileOpenTabs` (`background.js`) sidesteps the question: on every
service worker start (the same top-level-code hook that already runs the
heartbeat-gap check), it walks every managed site's currently-open tabs
and checks each one directly with `hasLiveContentScript` —
`chrome.tabs.sendMessage(tabId, {type: 'PING'})`, which rejects if
nothing in that tab is listening, since `content.js` now answers it. Only
tabs that fail the ping get `content-main.js`/`content.js` (re-)injected.

This makes the fix idempotent by construction rather than by careful
sequencing: a tab that was never actually disconnected (the computer
merely slept while the tab stayed open and alive) just answers the ping
and is left alone — no risk of double-injecting a live tab and ending up
with duplicate navigation listeners. A tab that lost its content script
for any reason, disable/re-enable being the common one, gets it back, and
re-injection re-runs `content.js`'s own initial-load check — if that tab
turns out not to actually be covered by a valid grant for its current
page, it gets redirected to `blocked.html` immediately as part of the
same pass, not left running ungated until some other event happens to
trigger it.

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
- Any detected URL change is debounced 500ms before being treated as a
  real navigation, to filter out sites that rewrite the URL (an analytics
  token, a hash-based scroll anchor) for reasons that aren't actually a
  new page — found from a real report of getting re-gated on what felt
  like the same page. This can't be solved with something like "ignore
  query-string changes," since some sites (e.g. `?v=VIDEO_ID` on the same
  path) rely on the query string to signal real navigation — the debounce
  filters transient/self-correcting churn without weakening detection of
  a sustained one. Not verified against a specific site; if this keeps
  happening, the debounce window or approach may need to be revisited
  with that site's actual URL behavior in hand.
- The unmonitored-gap reconstruction (see "Learning trends" above) can't
  distinguish "extension disabled" from "browser closed" or "computer
  asleep" — any of those produce the same heartbeat gap. It also can't
  measure dwell time directly, only estimate it from how close together
  history visits landed, so it's a rough directional signal for the trends
  view, not a number to treat as ground truth.

## Open questions — rationale not documented anywhere in the repo

- Why a bandit-based approach over a simpler mechanism (fixed schedule,
  static rules, manual-only overrides)?
- Why LinUCB specifically over other bandit algorithms?
- Why disjoint per-site models rather than a *full* shared/hybrid one (the
  paper this implements defines one) — a deliberate rejection for v0.1, or
  just out of scope? Cross-site warm-start (above) narrows this gap for a
  new site's starting point specifically, but doesn't address ongoing
  weight sharing across established sites.
- Why these particular default magnitudes (`alpha = 1.0`,
  `denyReward = 0.15`, `denyOverridePenalty = 0.4`,
  `penaltyPerMinute = 1/30`, etc.)? ADR 0001 found `alpha = 1.0` likely
  miscalibrated (~80x more regret than a tuned value in simulation) but
  deliberately didn't change it pending real usage data — see that ADR's
  Consequences section. The rest remain documented as *what* they do, not
  why these specific starting values versus others.
