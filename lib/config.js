// Shared defaults and small pure helpers used by background.js, popup.js and options.js.

export function minutesToMs(min) {
  return min * 60 * 1000;
}

export const ARM_DURATIONS_MIN = [0, 5, 15, 30]; // 0 = deny
export const DEFAULT_ALPHA = 1.0; // LinUCB exploration coefficient
export const DEFAULT_PENALTY_PER_MINUTE = 1 / 30; // -1 reward at 30 min of active use

// Every observation permanently shapes the model under vanilla LinUCB - a
// data point matters exactly as much a year later as it did the day it
// happened. That's fine if the world is stationary, but it isn't here: the
// bandit's own decisions are part of what shapes your future behavior
// around a site (a run of denials at some hour might genuinely change when
// you try again; a run of grants might change how often you do). A model
// that never forgets can't track that kind of shift - it stays anchored to
// however things looked before, for as long as that old data keeps
// outweighing the new. This discounts each site's A/b before every update
// (see LinUCBArm.update in lib/linucb.js) so recent observations get more
// say than old ones. Default 0.99 gives an effective memory of roughly
// 1/(1-gamma) ≈ 100 observations - long enough that ordinary day-to-day
// noise doesn't dominate the estimate, short enough that a real, sustained
// change in behavior shows up within weeks of typical use rather than
// months. 1.0 disables discounting entirely (the original behavior).
export const DEFAULT_DISCOUNT_FACTOR = 0.99;

// A brand-new managed site starts with zero data of its own, even if other
// managed sites already have plenty. This borrows a shrinkage-weighted
// average of what other sites have learned as a starting point instead of
// pure ignorance (see crossSiteWarmStart in lib/background-helpers.js) - 0
// disables it entirely (today's original cold-start behavior). Simulation
// (docs/adr/0002-recency-feature-and-cross-site-warm-start.md) found this
// reduces regret at every shrinkage tested, including with deliberately
// dissimilar sibling sites, at the reward shape shipped today - but the
// best-performing tested value (0.5) isn't the default here, for the same
// reason DEFAULT_ALPHA wasn't changed on ADR 0001's simulation alone:
// shipping a synthetic environment's optimum as a real default would be
// overfitting it. 0.2 is a deliberately more conservative middle ground,
// editable like every other bandit parameter.
export const DEFAULT_CROSS_SITE_WARM_START_WEIGHT = 0.2;

// Access itself is never a positive outcome — not accessing is. A denial
// (that stands, i.e. isn't later overridden) is rewarded outright; a grant
// is only ever a penalty, scaled by how long and how often it was used, with
// an extra flat penalty layered on if the grant only happened because a
// denial was overridden. There is no "but it was brief" bonus for actually
// using a site — the deny reward already covers the "good outcome" case, and
// a grant session's ceiling is 0, never positive.
export const DEFAULT_DENY_REWARD = 0.15;
export const DEFAULT_OVERRIDE_SESSION_PENALTY = 0.3;

// Opt-in, off by default. A denial that stands always pays DEFAULT_DENY_REWARD
// (a fixed +0.15, regardless of context); a grant's reward is clamped at 0 by
// computeGrantReward below. Those two ranges never overlap, which means no
// grant outcome can ever out-score a denial in expectation, no matter what
// the context is - the bandit cannot, even in principle, learn "granting is
// the right call here." An offline simulation (see eval/ and
// docs/adr/0001-reward-shaping-and-eval-harness.md) confirmed this: at a
// well-tuned alpha, the bandit converges to near-always-deny regardless of
// context, and grant selection never recovers once that happens.
// cleanGrantBonus closes that gap just enough to make learning "grant is
// fine here" possible: a grant session that ended almost immediately
// (<= CLEAN_GRANT_MAX_ACTIVE_MINUTES), wasn't an override, and had no other
// recent session on the site can score a small positive reward instead of
// capping at 0. It stays 0 (off, matching today's shipped behavior exactly)
// until you've read the ADR and decided you want it - the same simulation
// that motivated this also showed it isn't a strict improvement: it raises
// grant rate but also raised simulated regret over a short horizon, because
// most grant attempts in a risk-heavy environment aren't "clean." This is a
// lever to evaluate against your own real usage, not a default to flip
// blindly.
export const DEFAULT_CLEAN_GRANT_BONUS = 0;
export const CLEAN_GRANT_MAX_ACTIVE_MINUTES = 0.5;

// Every navigation needing its own decision, and a grant getting cut off the
// instant its timer hits zero, both treat a 40-minute documentary the same
// as a string of 15-second clips — but sustained, uninterrupted dwell time
// on one page is itself a signal this probably isn't compulsive scrolling.
// Two places use this threshold: content.js skips re-gating the next
// navigation if you dwelled on the current page at least this long first,
// and background.js's expiry handler tries a silent re-draw instead of a
// hard cutoff if you're still actively watching once a grant's timer runs
// out and you'd already been engaged this long.
export const DEFAULT_LONG_FORM_DWELL_MIN = 8;
// The cooldown between requests isn't a fixed number — it drifts down toward
// MIN when your recent sessions on a site have been brief, and gets pulled
// back up toward MAX when they haven't, using the same recent-active-time
// stat the bandit's context already tracks. See computeCooldownSec below.
export const DEFAULT_MIN_COOLDOWN_SEC = 5;
export const DEFAULT_MAX_COOLDOWN_SEC = 120;
export const DEFAULT_COOLDOWN_RAMP_SEC_PER_MIN = 8; // extra cooldown per minute of recent avg active time
export const TICK_PERIOD_MIN = 0.5; // active-time sampling cadence (chrome.alarms minimum granularity)
export const MAX_SESSIONS_LOGGED = 500;

// A learning-progress view needs some way to account for time on managed
// sites that the extension itself could never have logged — most commonly,
// time spent while it was manually disabled (the service worker doesn't run
// at all while disabled, so there is no possible in-extension log for that
// window). The heartbeat alarm below writes a timestamp on a fixed cadence
// whenever the extension IS running; a gap between two heartbeats bigger
// than ordinary alarm jitter means something stopped the service worker
// from running for a while (disable, browser closed, computer asleep — this
// can't tell which). When that's detected, chrome.history is checked for
// visits to managed sites during the gap, and a rough exposure estimate is
// logged for the trends view — see reconstructGap in background.js and
// estimateExposureMinutes in lib/background-helpers.js. This is a deliberate
// approximation, not a precise reconstruction: history visit timestamps
// don't capture dwell time directly, so it's estimated from the spacing
// between consecutive visits, capped so one stray visit followed by a long
// silence isn't counted as sustained exposure.
export const HEARTBEAT_PERIOD_MIN = 5;
export const HEARTBEAT_GAP_THRESHOLD_MIN = 12;
export const RECONSTRUCTED_VISIT_GAP_CAP_MIN = 15;

// How long past its own expiresAt a grant can be discovered before it's
// treated as stale rather than just slightly delayed (see isGrantStale in
// lib/background-helpers.js). Alarms can legitimately run a little late
// under normal operation; this only needs to be big enough to not misfire
// on that jitter; anything landing this far past its deadline is a real
// gap (most commonly: the extension was disabled), not scheduling noise.
export const STALE_GRANT_THRESHOLD_MIN = 5;

// A single brief session looks identical to the reward function whether it's
// one glance at a site or the 20th in the last half hour — duration alone
// can't tell a one-off from a binge made of short-form content, which is
// arguably the worse pattern of the two. This penalizes how many times
// you've already come back recently, on top of how long each visit was.
export const DEFAULT_FREQUENCY_WINDOW_MIN = 30;
export const DEFAULT_FREQUENCY_PENALTY_PER_SESSION = 0.1;
export const DEFAULT_MAX_FREQUENCY_PENALTY = 1.0;

// There's no way to tell from context alone whether a denial blocked
// mindless scrolling or something you actually needed (research, work,
// educational material) — only you know that. The override button on the
// blocked page lets you say so: it grants access anyway, and retroactively
// feeds this penalty back as the reward for the deny decision that just
// happened, so denying in that context gets less attractive over time
// instead of the bandit only ever learning from denials that stood.
export const DEFAULT_DENY_OVERRIDE_PENALTY = 0.4;

// A one-tap override defeats the point of denying in the first place — it
// has to cost you something to use even once, and cost progressively more
// the more you lean on it. The button stays disabled behind a wait (which
// grows with how many times you've already overridden this site recently),
// and once it's enabled it still requires a sustained press-and-hold rather
// than a single click, so it can't be tapped through on reflex.
export const DEFAULT_OVERRIDE_WINDOW_MIN = 240; // lookback for counting recent overrides per site
export const DEFAULT_OVERRIDE_BASE_DELAY_SEC = 20; // minimum wait before the button is even enabled
export const DEFAULT_OVERRIDE_DELAY_RAMP_SEC = 60; // extra wait per recent override in the window
export const DEFAULT_OVERRIDE_MAX_DELAY_SEC = 600;
export const DEFAULT_OVERRIDE_HOLD_MS = 3000; // press-and-hold duration once enabled

// Reaching for the override on the first denial and reaching for it after
// patiently going through several genuine deny-and-retry cycles (actually
// waiting out cooldowns, asking again through the normal flow) aren't the
// same thing — the second is itself a costly, effort-based signal that this
// probably matters. Each consecutive prior denial on this site (since the
// last grant or override) shaves this many seconds off the wait, on top of
// whatever the override-abuse ramp added.
export const DEFAULT_OVERRIDE_EFFORT_DISCOUNT_SEC = 8;

// The override earns you the one page it was used on, but if the very next
// click re-triggers the whole gate, the effort of getting through the wait
// and the hold bought you nothing. For a short window after a successful
// override, per-navigation re-gating is suspended — you get to actually use
// what you fought for before the gate comes back. Grace is stored as a
// diminishing hop-limited credit (see consumeGrace) rather than a flat time
// window; override's hop count is generous enough that it behaves like free
// browsing for the window's duration in practice, unlike the extend
// mechanic below, which deliberately grants very few hops.
export const DEFAULT_OVERRIDE_GRACE_MIN = 5;
export const DEFAULT_OVERRIDE_GRACE_HOP_COUNT = 50;

// The grace window is a hard cliff: fine for "let me finish what I was
// doing," but effort shouldn't evaporate the instant it lapses — if you
// come back to this site again in the next hour, that should still be
// easier than starting cold, just gradually less so the longer it's been.
// This is a small per-site cache: a "trust" value that jumps up when you
// override (an override IS a costly, deliberate signal) and decays with a
// half-life rather than expiring outright, so near-future access on that
// site is discounted by however much of that credit hasn't decayed away yet.
export const DEFAULT_TRUST_HALF_LIFE_MIN = 90;
export const DEFAULT_TRUST_OVERRIDE_BOOST = 0.6; // trust added (capped at 1) per successful override
export const DEFAULT_TRUST_MAX_DISCOUNT = 0.7; // at trust = 1, cooldown/override-wait are cut by up to 70%

// longFormDwellMin's dwell pass-through is automatic and low-stakes — staying
// on the same page past its own timer isn't really "one more site to gate."
// Navigating to an actually different URL is a different question, and by
// default it should still hit the gate every time — that's the whole point
// of per-navigation gating. The one exception: a session that's run
// extremely long (well past longFormDwellMin) is a strong enough signal that
// you can spend the same kind of effort the override button costs — a wait,
// then a sustained hold — to buy exactly one skipped redirect. It isn't a
// free pass and isn't automatic; the grace it buys is a diminishing,
// single-use credit that shrinks the moment it's spent (see consumeGrace)
// and lapses on its own if you don't use it.
export const DEFAULT_EXTREME_LONG_FORM_MIN = 45;
export const DEFAULT_EXTEND_OFFER_WINDOW_MIN = 2; // how long the blocked page offers the extend option for
export const DEFAULT_EXTEND_GRACE_MIN = 15; // grace window banked if you spend the effort to extend
export const DEFAULT_EXTEND_HOP_COUNT = 1; // navigations the grace covers before it's fully spent
export const DEFAULT_EXTEND_GRANT_MIN = 20; // duration of the grant created for the page you extend into

// A proactive, user-initiated block across every managed site at once —
// the opposite direction from everything else here: instead of the bandit
// deciding when you show up, you decide in advance not to show up at all.
// It doesn't touch the bandit's reward loop (see startBreak/overrideBreak
// in background.js) — this is a commitment device, not a bandit decision,
// so there's no context vector or arm choice behind it to train on.
//
// Unbounded would defeat two different purposes at once: an unreasonably
// long break locks out sites you may genuinely need before the cap is
// reached (this isn't a punishment mechanism), and if it could also be
// escaped instantly, it wouldn't function as a commitment device at all.
// breakMaxMin caps the first; the override settings below, applied without
// any trust discount (unlike the ordinary per-site override), keep the
// second deliberately harder to reach than backing out of a normal denial.
export const DEFAULT_BREAK_MAX_MIN = 180;
export const DEFAULT_BREAK_OVERRIDE_DELAY_SEC = 45;
export const DEFAULT_BREAK_OVERRIDE_HOLD_MS = 8000;

export function defaultSettings() {
  return {
    alpha: DEFAULT_ALPHA,
    discountFactor: DEFAULT_DISCOUNT_FACTOR,
    crossSiteWarmStartWeight: DEFAULT_CROSS_SITE_WARM_START_WEIGHT,
    armDurationsMin: ARM_DURATIONS_MIN.slice(),
    penaltyPerMinute: DEFAULT_PENALTY_PER_MINUTE,
    denyReward: DEFAULT_DENY_REWARD,
    overrideSessionPenalty: DEFAULT_OVERRIDE_SESSION_PENALTY,
    cleanGrantBonus: DEFAULT_CLEAN_GRANT_BONUS,
    minCooldownSec: DEFAULT_MIN_COOLDOWN_SEC,
    maxCooldownSec: DEFAULT_MAX_COOLDOWN_SEC,
    cooldownRampSecPerMin: DEFAULT_COOLDOWN_RAMP_SEC_PER_MIN,
    frequencyWindowMin: DEFAULT_FREQUENCY_WINDOW_MIN,
    frequencyPenaltyPerSession: DEFAULT_FREQUENCY_PENALTY_PER_SESSION,
    maxFrequencyPenalty: DEFAULT_MAX_FREQUENCY_PENALTY,
    denyOverridePenalty: DEFAULT_DENY_OVERRIDE_PENALTY,
    overrideWindowMin: DEFAULT_OVERRIDE_WINDOW_MIN,
    overrideBaseDelaySec: DEFAULT_OVERRIDE_BASE_DELAY_SEC,
    overrideDelayRampSec: DEFAULT_OVERRIDE_DELAY_RAMP_SEC,
    overrideMaxDelaySec: DEFAULT_OVERRIDE_MAX_DELAY_SEC,
    overrideHoldMs: DEFAULT_OVERRIDE_HOLD_MS,
    overrideEffortDiscountSec: DEFAULT_OVERRIDE_EFFORT_DISCOUNT_SEC,
    overrideGraceMin: DEFAULT_OVERRIDE_GRACE_MIN,
    overrideGraceHopCount: DEFAULT_OVERRIDE_GRACE_HOP_COUNT,
    trustHalfLifeMin: DEFAULT_TRUST_HALF_LIFE_MIN,
    trustOverrideBoost: DEFAULT_TRUST_OVERRIDE_BOOST,
    trustMaxDiscount: DEFAULT_TRUST_MAX_DISCOUNT,
    longFormDwellMin: DEFAULT_LONG_FORM_DWELL_MIN,
    extremeLongFormMin: DEFAULT_EXTREME_LONG_FORM_MIN,
    extendOfferWindowMin: DEFAULT_EXTEND_OFFER_WINDOW_MIN,
    extendGraceMin: DEFAULT_EXTEND_GRACE_MIN,
    extendHopCount: DEFAULT_EXTEND_HOP_COUNT,
    extendGrantMin: DEFAULT_EXTEND_GRANT_MIN,
    breakMaxMin: DEFAULT_BREAK_MAX_MIN,
    breakOverrideDelaySec: DEFAULT_BREAK_OVERRIDE_DELAY_SEC,
    breakOverrideHoldMs: DEFAULT_BREAK_OVERRIDE_HOLD_MS,
  };
}

// Requested break length, clamped to (0, settings.breakMaxMin] and rounded
// to the nearest whole minute. The cap is enforced here, server-side,
// rather than trusted from whatever a form field happened to send.
export function clampBreakMinutes(requestedMinutes, settings) {
  const n = Math.round(Number(requestedMinutes) || 0);
  return Math.max(1, Math.min(settings.breakMaxMin, n));
}

// Spends one hop of an extend-earned grace credit, if any is currently
// banked and unexpired. Returns { allowed, next } — next is the credit to
// persist afterward (or null to clear it): each spend halves whatever time
// was left AND decrements the hop counter, so the credit diminishes both by
// the clock running out and by how many new URLs it's already covered,
// rather than being a flat window that's either fully there or fully gone.
export function consumeGrace(graceEntry, nowMs) {
  if (!graceEntry || nowMs >= graceEntry.expiresAt || graceEntry.hopsRemaining <= 0) {
    return { allowed: false, next: null };
  }
  const remainingMs = graceEntry.expiresAt - nowMs;
  const hopsRemaining = graceEntry.hopsRemaining - 1;
  if (hopsRemaining <= 0) {
    return { allowed: true, next: null };
  }
  return { allowed: true, next: { expiresAt: nowMs + remainingMs / 2, hopsRemaining } };
}

// trustEntry is { value, updatedAt } or undefined. Decays exponentially with
// the configured half-life rather than expiring outright — so the credit
// from an override fades smoothly rather than cutting off at a hard cliff.
export function decayedTrust(trustEntry, nowMs, halfLifeMin) {
  if (!trustEntry || !trustEntry.value) return 0;
  const elapsedMin = (nowMs - trustEntry.updatedAt) / 60000;
  const decayed = trustEntry.value * Math.pow(0.5, elapsedMin / halfLifeMin);
  return Math.max(0, Math.min(1, decayed));
}

// Discounts a friction value (cooldown or override-wait seconds) by however
// much decayed trust is currently banked for this site, up to trustMaxDiscount.
export function applyTrustDiscount(seconds, trust, settings) {
  const discount = Math.max(0, Math.min(1, trust)) * settings.trustMaxDiscount;
  return seconds * (1 - discount);
}

// How long the override button stays disabled after a denial, before you can
// even start the press-and-hold. Grows with recentOverrideCount (overrides
// already used on this site within overrideWindowMin), so repeated reliance
// on the escape hatch gets harder to reach, not easier — but shrinks with
// denyStreak (consecutive genuine denials on this site since the last grant
// or override), so persistence through the normal request flow is rewarded
// rather than treated the same as an impulsive first-try override. Floors at
// 0 (instant) rather than at the base, since enough demonstrated effort
// should be able to clear the wait entirely.
export function computeOverrideDelaySec(recentOverrideCount, denyStreak, settings) {
  const raw =
    settings.overrideBaseDelaySec +
    settings.overrideDelayRampSec * recentOverrideCount -
    settings.overrideEffortDiscountSec * denyStreak;
  return Math.max(0, Math.min(settings.overrideMaxDelaySec, raw));
}

// Consecutive prior sessions on this site that were denied and never
// overridden, most-recent-first, stopping at the first grant or override —
// i.e. how many times in a row you've gone through the normal ask-and-wait
// flow since the last time you actually got in.
export function recentDenyStreak(sessions, hostname) {
  const hostSessions = sessions.filter((s) => s.hostname === hostname);
  let streak = 0;
  for (let i = hostSessions.length - 1; i >= 0; i--) {
    const s = hostSessions[i];
    if (s.decision === 'deny' && !s.overridden) {
      streak += 1;
    } else {
      break;
    }
  }
  return streak;
}

// Scales the retry cooldown with how much you've actually been using the
// site lately (avgRecentActiveMin — same stat behind the bandit's context):
// stayed brief recently -> cooldown drifts back down toward the floor;
// been running long -> cooldown gets pulled up toward the ceiling. This is
// what makes the friction adaptive instead of a fixed number that only ever
// goes away.
export function computeCooldownSec(avgRecentActiveMin, settings) {
  const raw = settings.minCooldownSec + settings.cooldownRampSecPerMin * avgRecentActiveMin;
  return Math.max(settings.minCooldownSec, Math.min(settings.maxCooldownSec, raw));
}

export function normalizeHostname(input) {
  try {
    const withScheme = /^[a-zA-Z]+:\/\//.test(input) ? input : `https://${input}`;
    return new URL(withScheme).hostname.replace(/^www\./, '');
  } catch {
    return null;
  }
}

export function hostnameFromUrl(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return null;
  }
}

// Reward for a granted session: never positive — access is penalized, not
// rewarded, scaled by how long it ran and how many other sessions on this
// site already landed within the last frequencyWindowMin (recentSessionCount
// counts prior sessions only, not this one). If this session only happened
// because a denial was overridden, an extra flat penalty applies on top —
// overriding should cost more than an ordinary grant, not just correct the
// bandit's opinion of the original deny decision.
export function computeGrantReward(activeMinutes, recentSessionCount, wasOverride, settings) {
  const durationPenalty = activeMinutes * settings.penaltyPerMinute;
  const frequencyPenalty = Math.min(settings.maxFrequencyPenalty, recentSessionCount * settings.frequencyPenaltyPerSession);
  const overridePenalty = wasOverride ? settings.overrideSessionPenalty : 0;
  let reward = -durationPenalty - frequencyPenalty - overridePenalty;

  const bonus = settings.cleanGrantBonus || 0;
  const isClean = activeMinutes <= CLEAN_GRANT_MAX_ACTIVE_MINUTES && recentSessionCount === 0 && !wasOverride;
  if (isClean && bonus > 0) reward += bonus;

  const ceiling = isClean ? bonus : 0;
  return Math.max(-1, Math.min(ceiling, reward));
}

// Cyclical time-of-day / day-of-week encoding plus recent-usage stats.
// Feature order must match FEATURE_DIM in lib/linucb.js.
export function buildContext(now, recentStats) {
  const hourAngle = ((now.getHours() + now.getMinutes() / 60) / 24) * 2 * Math.PI;
  const dowAngle = (now.getDay() / 7) * 2 * Math.PI;
  const freq24h = Math.min(1, recentStats.sessionsLast24h / 10);
  const avgRecentMin = Math.min(1, recentStats.avgRecentActiveMin / 60);
  return [
    1,
    Math.sin(hourAngle),
    Math.cos(hourAngle),
    Math.sin(dowAngle),
    Math.cos(dowAngle),
    freq24h,
    avgRecentMin,
  ];
}
