# Mindful Access Bandit

A Manifest V3 Edge/Chromium extension that uses a contextual bandit to decide,
each time you try to visit a site you've chosen to restrict, whether to grant
brief, time-limited access — and learns from what you actually do with it.

## How it works

1. **You pick sites to manage** (popup or options page). Managing a site
   requests host permission for that domain and starts redirecting
   navigations to it to a local "Access limited" page instead of loading it.
2. **You click "Request access"** on that page. The background service
   worker builds a context vector from:
   - time of day (cyclical, sin/cos of hour)
   - day of week (cyclical, sin/cos)
   - how many sessions you've had on that site in the last 24h
   - your average active time over the last 5 sessions on that site
3. A **disjoint LinUCB bandit** (one independent model per site) scores four
   arms — deny, 5 min, 15 min, 30 min — and picks the highest upper-confidence
   bound. If it picks "deny," nothing is granted, but you can just try again
   after a short cooldown (default 10 sec) — every new destination gets its
   own fresh decision anyway, so this is a brief pause rather than a lockout.
   If it grants time, you're redirected to the
   page you originally wanted, with the chosen duration acting as a ceiling
   for that one page — if you just sit on it, you get kicked back to the
   blocked page once the timer runs out, *unless* you're still actively
   watching something long-form (point 9, below).
4. While access is granted, a periodic alarm samples whether that site's tab
   is the active, focused tab and accumulates active seconds — this is the
   **actual usage**, not just the allotted ceiling.
5. **A grant only ever covers the one page you requested it for** — with one
   exception (point 9). A content script on every managed site intercepts
   its client-side routing (`pushState`/`replaceState`/`popstate` — how sites
   like video or feed sites move between videos/posts without a full page
   load, which network-level blocking can't see) and, the moment you
   navigate to anything else, ends the current grant right there and sends
   you back to the blocked page for the new destination. Every new
   video/article/whatever gets its own fresh bandit decision, built from the
   latest context — there's no free-roam window covering whatever you click
   next just because the previous grant hadn't expired yet.
6. When a grant ends (you navigated away, the timer ran out, or you ended it
   early), the session is finalized: a reward — never positive, see below —
   is computed from actual active minutes on that one page and fed back into
   that site's bandit model, updating the estimate for that context (time of
   day, day of week, recent usage) and arm (that duration). Over many
   sessions, this is what lets it learn — e.g. shorter/denied grants in
   contexts where you tend to linger, longer ones (less-penalized, never
   positive) where you tend to glance and move on — even though each
   individual navigation still needs its own decision.
7. **If it denies you and you actually needed that page** (a lookup for work,
   something educational, whatever), there's no way for the bandit to know
   that from context alone — only you know. The blocked page shows an
   "I really need this" button after a denial, but it isn't a one-tap escape
   hatch: it starts disabled behind a wait (default 20 sec) that moves in two
   directions depending on what you've actually been doing —
   - **up** by 60 sec for every override you've already used on this site in
     the last 4 hours, so leaning on it repeatedly makes it progressively
     harder to reach, not easier;
   - **down** by 8 sec for every consecutive denial you've patiently gone
     through the normal ask-and-wait flow for since your last grant or
     override on this site — reaching for the override after getting told no
     three times in a row (having actually waited out the cooldown each time)
     isn't the same as reaching for it on the very first try, and the wait
     reflects that; it can drop all the way to instant with enough of this.

   Once enabled it still requires a sustained 3-second press-and-hold rather
   than a click. Only after holding it through does it grant you the
   smallest available duration and — this is the actual point — retroactively
   flip the reward for the deny decision that just happened from its normal
   positive `denyReward` down to `-denyOverridePenalty` (default 0.4). So a
   context that keeps getting overridden becomes progressively less likely to
   get denied again — but reaching for the override itself has to cost
   something, and cost more the more you lean on it, or it just becomes the
   button you always press. It costs the resulting session something too:
   see `overrideSessionPenalty` below.

   That effort should buy you something beyond the one page, though —
   otherwise the very next click just re-triggers the whole gate and the
   wait/hold was pointless. A successful override opens a grace window
   (`overrideGraceMin`, default 5 min) during which per-navigation re-gating
   (point 5, above) is suspended on that site: you can click through to other
   videos/pages without each one re-triggering the blocked page. It's still
   bounded — the underlying grant's own timer, and the tab-kickout from point
   5's expiry handling, both still apply — grace only suspends the *extra*
   per-click gate, not the overall time ceiling.
8. **That effort shouldn't evaporate the instant grace lapses, either.** Each
   site keeps a small decaying "trust" credit (0 to 1) in `chrome.storage.local`,
   bumped up by `trustOverrideBoost` (default 0.6, capped at 1) whenever you
   successfully override, and decaying back toward 0 on an exponential
   half-life (`trustHalfLifeMin`, default 90 min) rather than expiring
   outright. Whatever trust hasn't decayed away discounts both the retry
   cooldown and the override wait — up to `trustMaxDiscount` (default 70%) at
   full trust — so coming back to a site again within the next hour or so
   after demonstrating real need is noticeably easier than starting cold,
   fading smoothly rather than snapping back the moment the grace window
   ends. Current trust for a site is visible in the bandit-state debug panel
   on the options page.
9. **Every navigation needing its own decision, and a grant cutting off the
   instant its timer hits zero, both treat a 40-minute documentary the same
   as a string of 15-second clips — but sustained, uninterrupted dwell time
   on one page is itself a signal this probably isn't compulsive scrolling.**
   `longFormDwellMin` (default 8 min) is used in two places:
   - **Per-navigation:** if you dwelled on the page you're leaving at least
     this long, the content script lets the next navigation through without
     re-triggering the gate (the same pass-through mechanism grace uses,
     point 7) — one long video into a related long video doesn't interrupt,
     while a rapid string of shorts still does, since none of them individually
     clear the threshold.
   - **On grant expiry:** if the tab is still active and focused on the site
     when a grant's timer runs out, and you'd already been engaged at least
     `longFormDwellMin`, the extension doesn't hard-cut you — it finalizes
     that session normally (reward included) and silently asks the bandit
     again with the now-current context, extending the grant if it still
     says yes. It isn't a free pass: heavier recent usage by that point may
     well tip the fresh decision toward denying, and then you do get kicked
     to the blocked page — it's just not an *unconditional* cutoff at the
     fixed timer mark the way it is for anyone who hasn't shown that kind of
     sustained engagement.

   The per-navigation pass-through only judges the one hop, though: a long
   video followed by a short glance still gates the click after *that*. So a
   qualifying long-form session also banks the same grace/trust credit an
   override does (points 7-8) — `longFormGraceMin` (default 10 min) and
   `longFormTrustBoost` (default 0.35, smaller than the override's 0.6 since
   this is a passive signal, not a deliberate costly action). One genuinely
   engaging video buys some slack for what you click next too, not just a
   single hop's exemption.

## Reward function

Access itself is never rewarded — only *not* accessing is. There are two
separate cases:

**A denial that stands** (not later overridden) gets a flat positive reward:

```
reward = denyReward   (default 0.15)
```

**A granted session** — whether it came from a normal bandit decision or
from overriding a denial — is only ever a penalty, never positive:

```
reward = - activeMinutes * penaltyPerMinute
         - min(maxFrequencyPenalty, recentSessionCount * frequencyPenaltyPerSession)
         - (wasOverride ? overrideSessionPenalty : 0)
```

clamped to `[-1, 0]`. `recentSessionCount` is how many other sessions on this
site already landed within the last `frequencyWindowMin` (default 30) — this
exists because duration alone can't distinguish a single long video from a
binge of many short ones; without it, a string of 90-second videos would each
score close to 0 (the best a grant can ever do) and the bandit would read
that as "this is fine to keep allowing." The frequency term counteracts that:
each repeat visit within the window chips away at the reward regardless of
how short it was. If the session only happened because you overrode a
denial, `overrideSessionPenalty` (default 0.3) applies on top, flat — this is
separate from (and in addition to) the `denyOverridePenalty` that
retroactively flips the *original* deny decision's reward from positive to
negative; together they mean an override costs you twice: once on the
decision that got overridden, once on the session it produced. Since a grant
can never score above 0 and a standing denial always scores `denyReward`
(positive), the bandit's baseline preference is always toward denying —
access has to be earned back on a per-context basis by grant arms losing
less than they otherwise would, never by racking up a positive score of their
own. Defaults: `penaltyPerMinute = 1/30` (30 active minutes ≈ -1),
`denyReward = 0.15`, `overrideSessionPenalty = 0.3`,
`frequencyPenaltyPerSession = 0.1`, `maxFrequencyPenalty = 1.0`. All of
this — plus the exploration coefficient (alpha) and the arm durations — is
editable on the options page.

## Cooldown between requests

The retry cooldown isn't a fixed number — it's computed each time from the
same recent-usage stat that feeds the bandit's context:

```
cooldownSec = clamp(minCooldownSec + cooldownRampSecPerMin * avgRecentActiveMin, minCooldownSec, maxCooldownSec)
```

`avgRecentActiveMin` is your average actual active time over the last 5
sessions on that site. Kept sessions brief lately → the ramp term is small →
cooldown drifts down toward the floor (default 5 sec). Been running long →
cooldown gets pulled up toward the ceiling (default 120 sec). So the friction
naturally eases off the better your recent usage looks, and stiffens back up
the moment it doesn't — instead of a fixed delay that only ever gets easier
to click through regardless of how much time you're actually spending.
`minCooldownSec`, `maxCooldownSec`, and `cooldownRampSecPerMin` are all
editable on the options page.

## Data storage

Everything (managed sites, bandit weights, session log, settings) lives in
`chrome.storage.local` — nothing leaves the device.

## Install (unpacked, developer mode)

1. Open `edge://extensions`.
2. Turn on **Developer mode** (bottom-left toggle).
3. Click **Load unpacked** and select this folder.
4. Click the extension icon, add a site you want to restrict, and try
   visiting it.

## Files

- `manifest.json` — MV3 manifest (`declarativeNetRequest`, `alarms`, `tabs`,
  `scripting`, `storage`; host permissions requested per-site via the
  optional permissions API, not baked in up front).
- `background.js` — service worker: decision logic, DNR rule management,
  dynamic content-script (re)registration per managed site, active-time
  tracking, session finalization, messaging API for the UI pages and content
  script.
- `content-main.js` — registered in the page's own MAIN world (not the
  extension's isolated world) on every managed site. Patches
  `history.pushState`/`replaceState` so client-side route changes — the next
  video, the next short, the next post — are actually seen; an isolated-world
  override only patches a copy the page's own script never calls, and
  wouldn't fire for fast in-feed navigation (e.g. swiping through shorts) at
  all. Rebroadcasts every navigation as a DOM event.
- `content.js` — registered in the isolated world (has `chrome.*` API
  access) on every managed site; listens for `content-main.js`'s event and
  ends the current grant, forcing a fresh decision for the new destination.
- `lib/linucb.js` — the LinUCB bandit implementation (plain JS, no deps).
- `lib/config.js` — shared constants, context-feature builder, reward function.
- `blocked.html` / `blocked.js` — the page shown instead of a blocked site.
- `popup.html` / `popup.js` — quick add/remove sites, see/end the active grant
  for the current tab's site.
- `options.html` / `options.js` — full site list, bandit/reward parameters,
  per-site bandit debug view (current arm scores), session history.

## Development

Requires Node 18+ — only for running tests. The extension itself has zero
runtime dependencies and no build step; `Load unpacked` runs the source files
directly.

```
npm test
```

Runs the pure-function test suite (`lib/*.test.js`, using Node's built-in
`node:test` runner — no test framework dependency) covering the bandit math
and the reward/cooldown/trust/override calculations. There's no automated
coverage of the browser-integration pieces (`background.js`'s
`chrome.*`-API-driven logic, `content.js`/`content-main.js`, the DNR rules) —
those need manual verification in an actual loaded extension; see Install,
above.

## Known limitations (MVP scope)

- Blocking only covers top-level (`main_frame`) navigations, not iframes.
- Active-time tracking samples on a timer (default every 30s) rather than
  listening to every focus/visibility event, so it's an approximation.
- Each managed site gets its own independent bandit model (no sharing of
  learned weights across sites).
