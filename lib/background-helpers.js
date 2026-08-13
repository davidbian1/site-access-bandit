// Pure(ish) helpers used by background.js, split out so they can be unit
// tested without mocking the chrome.* APIs the rest of the service worker
// depends on.

import { LinUCB, FEATURE_DIM, identity, matAdd, matScale, vecAdd, vecScale } from './linucb.js';
import { minutesToMs, BREAK_DURATIONS_MIN } from './config.js';

// ---- bandit construction --------------------------------------------------

// A brand-new site (or one whose saved state no longer matches current
// settings) starting from pure ignorance (A=I, b=0) wastes whatever other
// managed sites have already learned. This borrows a shrinkage-weighted
// average of other sites' *learned* contribution (each sibling's A minus
// its own identity baseline, so a site with more accumulated data doesn't
// also inject more regularization than a fresh site should start with) —
// see docs/adr/0002-recency-feature-and-cross-site-warm-start.md for the
// simulation this is based on: it reduced regret at every shrinkage tested,
// including with deliberately dissimilar sibling sites, at the reward
// shape this ships with today. Returns null (meaning: cold-start as
// before) if shrinkage is 0 or there are no eligible siblings.
export function crossSiteWarmStart(banditState, excludeHostname, nArms, featureDim, shrinkage) {
  if (!shrinkage) return null;
  const siblings = Object.entries(banditState)
    .filter(([hostname, state]) => hostname !== excludeHostname && state && state.d === featureDim && state.arms.length === nArms)
    .map(([, state]) => state);
  if (siblings.length === 0) return null;

  const arms = [];
  for (let a = 0; a < nArms; a++) {
    let sumLearnedA = matScale(identity(featureDim), 0);
    let sumB = new Array(featureDim).fill(0);
    for (const state of siblings) {
      const arm = state.arms[a];
      sumLearnedA = matAdd(sumLearnedA, matAdd(arm.A, matScale(identity(featureDim), -1)));
      sumB = vecAdd(sumB, arm.b);
    }
    const avgLearnedA = matScale(sumLearnedA, 1 / siblings.length);
    const avgB = vecScale(sumB, 1 / siblings.length);
    arms.push({
      A: matAdd(identity(featureDim), matScale(avgLearnedA, shrinkage)),
      b: vecScale(avgB, shrinkage),
    });
  }
  return arms;
}

// Every call site needs the same four things off of `store` to load or
// construct a site's bandit — this used to be a 5-argument function
// (getBandit) called identically five separate times in background.js.
// Doesn't touch chrome.* at all, so it belongs here rather than there.
export function getBanditFor(store, hostname) {
  const { banditState, settings } = store;
  const nArms = settings.armDurationsMin.length;
  const saved = banditState[hostname];
  // If the arm count changed (user edited arm durations in settings) or the
  // feature dimension changed, the old per-arm state no longer lines up -
  // start fresh (or warm-started, below) for this site.
  if (saved && saved.arms.length === nArms && saved.d === FEATURE_DIM) {
    return LinUCB.fromJSON({ ...saved, alpha: settings.alpha, gamma: settings.discountFactor });
  }
  const warmStartArms = crossSiteWarmStart(banditState, hostname, nArms, FEATURE_DIM, settings.crossSiteWarmStartWeight);
  if (warmStartArms) {
    return LinUCB.fromJSON({ d: FEATURE_DIM, alpha: settings.alpha, gamma: settings.discountFactor, arms: warmStartArms });
  }
  return new LinUCB(nArms, FEATURE_DIM, settings.alpha, settings.discountFactor);
}

// A single global bandit (not per-site, unlike getBanditFor) that picks the
// suggested "take a break" duration — see BREAK_DURATIONS_MIN's comment in
// lib/config.js and docs/adr/0003-break-duration-bandit-and-fatigue-feature.md.
// Its arm count is always BREAK_DURATIONS_MIN.length regardless of the
// current breakMaxMin setting; eligibleBreakArmIndices (lib/config.js)
// filters which of those arms are actually selectable at suggestion time.
export function getBreakBandit(store) {
  const { breakBanditState, settings } = store;
  const nArms = BREAK_DURATIONS_MIN.length;
  if (breakBanditState && breakBanditState.arms.length === nArms && breakBanditState.d === FEATURE_DIM) {
    return LinUCB.fromJSON({ ...breakBanditState, alpha: settings.breakAlpha, gamma: settings.breakDiscountFactor });
  }
  return new LinUCB(nArms, FEATURE_DIM, settings.breakAlpha, settings.breakDiscountFactor);
}

// ---- declarativeNetRequest rule ids -----------------------------------

export function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export async function ruleIdFor(hostname, ruleIds, nextRuleId) {
  if (ruleIds[hostname]) return { id: ruleIds[hostname], ruleIds, nextRuleId };
  const id = nextRuleId;
  ruleIds[hostname] = id;
  return { id, ruleIds, nextRuleId: nextRuleId + 1 };
}

// ---- grants -------------------------------------------------------------

export function makeGrant(armIndex, durationMin, context, now, targetUrl, extra = {}) {
  return {
    armIndex,
    durationMin,
    context,
    grantedAt: now,
    expiresAt: now + minutesToMs(durationMin),
    activeSeconds: 0,
    targetUrl,
    ...extra,
  };
}

// A grant is "stale" if it's discovered well after its own expiresAt should
// have ended it - the normal path is the expire:<hostname> alarm firing
// right around expiresAt and finalizing it promptly. Landing here instead
// means the service worker wasn't running to catch that moment (most
// commonly: the extension was disabled, which also stops active-time
// tracking entirely and leaves the site completely unrestricted). Either
// way, grant.activeSeconds can no longer be trusted as a true measure of
// how long the site was actually used - see finalizeSession in
// background.js, which uses this to skip training the bandit on a reward
// computed from an undercounted number.
export function isGrantStale(grant, nowMs, thresholdMin) {
  return nowMs - grant.expiresAt > minutesToMs(thresholdMin);
}

// Whether a grant that just expired looks like genuine sustained engagement
// rather than a quick glance — the signal that lets handleExpiry silently
// re-ask the bandit instead of hard-cutting a still-active viewer. Capped at
// the grant's own duration: without the cap, an arm shorter than
// longFormDwellMin (e.g. a 5-minute grant against an 8-minute dwell floor)
// could never reach the threshold before expiring on its own, making the
// shortest arm structurally exempt from this protection no matter how
// attentively it was used. Fully using a short grant is itself a genuine
// engagement signal, not a lesser one just because the ceiling was lower.
export function isLongFormEngaged(activeSeconds, durationMin, longFormDwellMin) {
  return activeSeconds >= Math.min(longFormDwellMin, durationMin) * 60;
}

// ---- global (cross-site) usage stats --------------------------------------

// Unlike recentStatsFor (per-hostname), this rolls up every managed site's
// sessions together — the "fatigue" signal the break-duration bandit's
// context is built from (see docs/adr/0003 — this was tested and found NOT
// to help the *per-site* bandit's own context in simulation, so it's used
// here only, not folded into buildContext's normal per-site callers).
// Includes reconstructed (disabled-gap) sessions same as anything else with
// real activeMinutes — that time was still spent on a managed site, whether
// or not the extension was running to watch it happen directly.
export function globalFatigueStats(sessions, nowMs) {
  const dayAgo = nowMs - 24 * 60 * 60 * 1000;
  let sessionsLast24h = 0;
  let totalActiveMinLast24h = 0;
  for (const s of sessions) {
    if (s.grantedAt >= dayAgo) {
      sessionsLast24h += 1;
      totalActiveMinLast24h += s.activeMinutes || 0;
    }
  }
  return { sessionsLast24h, totalActiveMinLast24h };
}

// ---- unmonitored-gap reconstruction ---------------------------------------

// history.search only returns a page's *last* visit time within the search
// window, not a full visit log — so distinct search hits already correspond
// to distinct visits. Dwell time still isn't directly observable; this
// estimates it from the spacing between consecutive visits (closer together
// reads as one continuous stretch, capped at capMinutesPerGap so a visit
// followed by a long silence doesn't get credited with sitting open the
// whole time), plus a flat minimum for the final visit, which has no
// following gap to measure against.
export function estimateExposureMinutes(sortedVisitTimesMs, capMinutesPerGap) {
  if (sortedVisitTimesMs.length === 0) return 0;
  const minPerVisit = 0.5;
  let total = minPerVisit; // the last (or only) visit
  for (let i = 1; i < sortedVisitTimesMs.length; i++) {
    const gapMin = (sortedVisitTimesMs[i] - sortedVisitTimesMs[i - 1]) / 60000;
    total += Math.min(capMinutesPerGap, Math.max(minPerVisit, gapMin));
  }
  return total;
}

// ---- recent-usage stats --------------------------------------------------

export function recentStatsFor(sessions, hostname, nowMs, frequencyWindowMin = 0, overrideWindowMin = 0) {
  const dayAgo = nowMs - 24 * 60 * 60 * 1000;
  const windowAgo = nowMs - frequencyWindowMin * 60 * 1000;
  const overrideWindowAgo = nowMs - overrideWindowMin * 60 * 1000;
  const hostSessions = sessions.filter((s) => s.hostname === hostname);
  const last24h = hostSessions.filter((s) => s.grantedAt >= dayAgo);
  const inFrequencyWindow = hostSessions.filter((s) => s.decision === 'grant' && s.grantedAt >= windowAgo);
  const recentOverrides = hostSessions.filter((s) => s.overridden && s.grantedAt >= overrideWindowAgo);
  const recentFive = hostSessions.slice(-5);
  const avgRecentActiveMin = recentFive.length
    ? recentFive.reduce((sum, s) => sum + (s.activeMinutes || 0), 0) / recentFive.length
    : 0;
  return {
    sessionsLast24h: last24h.length,
    avgRecentActiveMin,
    sessionsInFrequencyWindow: inFrequencyWindow.length,
    overridesInWindow: recentOverrides.length,
  };
}
