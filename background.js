import {
  TICK_PERIOD_MIN,
  MAX_SESSIONS_LOGGED,
  STALE_GRANT_THRESHOLD_MIN,
  HEARTBEAT_PERIOD_MIN,
  HEARTBEAT_GAP_THRESHOLD_MIN,
  RECONSTRUCTED_VISIT_GAP_CAP_MIN,
  minutesToMs,
  defaultSettings,
  hostnameFromUrl,
  buildContext,
  computeGrantReward,
  computeCooldownSec,
  computeOverrideDelaySec,
  recentDenyStreak,
  decayedTrust,
  applyTrustDiscount,
  consumeGrace,
} from './lib/config.js';
import {
  escapeRegex,
  ruleIdFor,
  makeGrant,
  recentStatsFor,
  isGrantStale,
  isLongFormEngaged,
  getBanditFor,
  estimateExposureMinutes,
} from './lib/background-helpers.js';

const TICK_ALARM = 'tick';
const HEARTBEAT_ALARM = 'heartbeat';

// ---- storage helpers -------------------------------------------------

async function getStore() {
  const data = await chrome.storage.local.get([
    'sites',
    'settings',
    'banditState',
    'sessions',
    'grants',
    'grace',
    'trust',
    'extendEligible',
    'ruleIds',
    'lastRequestAt',
    'nextRuleId',
    'lastHeartbeat',
  ]);
  return {
    sites: data.sites || [],
    settings: { ...defaultSettings(), ...(data.settings || {}) },
    banditState: data.banditState || {},
    sessions: data.sessions || [],
    grants: data.grants || {},
    grace: data.grace || {},
    trust: data.trust || {},
    extendEligible: data.extendEligible || {},
    ruleIds: data.ruleIds || {},
    lastRequestAt: data.lastRequestAt || {},
    nextRuleId: data.nextRuleId || 1,
    lastHeartbeat: data.lastHeartbeat || 0,
  };
}

function trustFor(store, hostname, now) {
  return decayedTrust(store.trust[hostname], now, store.settings.trustHalfLifeMin);
}

async function setStore(partial) {
  await chrome.storage.local.set(partial);
}

// ---- declarativeNetRequest rule management ----------------------------

async function rebuildBlockRules() {
  const { sites, grants, ruleIds, nextRuleId } = await getStore();
  const existing = await chrome.declarativeNetRequest.getDynamicRules();
  const removeRuleIds = existing.map((r) => r.id);

  let nextId = nextRuleId;
  const addRules = [];
  for (const site of sites) {
    if (grants[site.hostname]) continue; // currently granted — leave unblocked
    const assign = await ruleIdFor(site.hostname, ruleIds, nextId);
    nextId = assign.nextRuleId;
    const escaped = escapeRegex(site.hostname);
    addRules.push({
      id: assign.id,
      priority: 1,
      condition: {
        regexFilter: `^https?://([a-zA-Z0-9-]+\\.)*${escaped}(:[0-9]+)?(/.*)?$`,
        resourceTypes: ['main_frame'],
      },
      action: {
        type: 'redirect',
        redirect: {
          regexSubstitution: `chrome-extension://${chrome.runtime.id}/blocked.html?site=${encodeURIComponent(
            site.hostname
          )}&target=\\0`,
        },
      },
    });
  }

  await chrome.declarativeNetRequest.updateDynamicRules({ removeRuleIds, addRules });
  await setStore({ ruleIds, nextRuleId: nextId });
}

// ---- content-script enforcement (catches client-side routing on any site) --

const CONTENT_SCRIPT_ID_PREFIX = 'enforce-';

async function rebuildContentScripts() {
  const { sites } = await getStore();
  const existing = await chrome.scripting.getRegisteredContentScripts();
  const existingIds = existing.map((s) => s.id);
  if (existingIds.length) await chrome.scripting.unregisterContentScripts({ ids: existingIds });
  if (sites.length === 0) return;

  const scripts = [];
  for (const site of sites) {
    const matches = [`*://*.${site.hostname}/*`, `*://${site.hostname}/*`];
    // MAIN world: patches the page's real history.pushState/replaceState so
    // client-side routing (e.g. video-to-video, short-form swipe feeds) is
    // actually observed — an isolated-world override never sees calls made
    // by the page's own script.
    scripts.push({
      id: `${CONTENT_SCRIPT_ID_PREFIX}main-${site.hostname}`,
      matches,
      js: ['content-main.js'],
      runAt: 'document_start',
      world: 'MAIN',
    });
    // Isolated world: has chrome.* API access, does the actual enforcement.
    scripts.push({
      id: `${CONTENT_SCRIPT_ID_PREFIX}${site.hostname}`,
      matches,
      js: ['content.js'],
      runAt: 'document_start',
    });
  }
  await chrome.scripting.registerContentScripts(scripts);
}

// Registering a content script only affects future navigations/frames, not
// tabs already sitting on the site — inject into those immediately so a
// freshly-managed site is enforced without requiring a manual reload.
async function injectIntoOpenTabs(hostname) {
  let tabs;
  try {
    tabs = await chrome.tabs.query({ url: [`*://*.${hostname}/*`, `*://${hostname}/*`] });
  } catch {
    tabs = [];
  }
  for (const tab of tabs) {
    if (!tab.id) continue;
    try {
      await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['content-main.js'], world: 'MAIN' });
      await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['content.js'] });
    } catch {
      // tab may not be script-injectable (e.g. a chrome:// page) — skip
    }
  }
}

// ---- alarms -------------------------------------------------------------

async function ensureTickAlarm() {
  const existing = await chrome.alarms.get(TICK_ALARM);
  if (!existing) chrome.alarms.create(TICK_ALARM, { periodInMinutes: TICK_PERIOD_MIN });
}

// Runs regardless of whether any site currently has a grant (unlike the tick
// alarm), so there's always a recent timestamp to compare against — the gap
// between two heartbeats is the only way to notice the service worker wasn't
// running for a stretch (see HEARTBEAT_GAP_THRESHOLD_MIN in lib/config.js).
async function ensureHeartbeatAlarm() {
  const existing = await chrome.alarms.get(HEARTBEAT_ALARM);
  if (!existing) chrome.alarms.create(HEARTBEAT_ALARM, { periodInMinutes: HEARTBEAT_PERIOD_MIN });
}

// Best-effort reconstruction of exposure to managed sites during a window
// the service worker wasn't running to observe directly — see
// HEARTBEAT_GAP_THRESHOLD_MIN's comment in lib/config.js for why this exists
// and what it can and can't tell you. Logged as a distinct session shape
// (reconstructed: true, no armIndex/context/reward) so it's visible in the
// trends view but never trains the bandit — there's no real context vector
// or arm choice behind an estimate like this.
async function reconstructGap(startMs, endMs) {
  const { sites, sessions } = await getStore();
  if (sites.length === 0) return;

  const newSessions = [];
  for (const site of sites) {
    let results;
    try {
      results = await chrome.history.search({ text: site.hostname, startTime: startMs, endTime: endMs, maxResults: 1000 });
    } catch {
      continue; // history permission not yet granted, or API unavailable
    }
    const visitTimes = results
      .filter((r) => {
        const h = hostnameFromUrl(r.url || '');
        return h && (h === site.hostname || h.endsWith(`.${site.hostname}`));
      })
      .map((r) => r.lastVisitTime)
      .filter((t) => typeof t === 'number')
      .sort((a, b) => a - b);
    if (visitTimes.length === 0) continue;

    newSessions.push({
      hostname: site.hostname,
      reconstructed: true,
      grantedAt: startMs,
      endedAt: endMs,
      activeMinutes: estimateExposureMinutes(visitTimes, RECONSTRUCTED_VISIT_GAP_CAP_MIN),
      reward: null,
      decision: 'reconstructed',
      endReason: 'unmonitored-gap',
    });
  }
  if (newSessions.length === 0) return;

  let updated = sessions.concat(newSessions);
  if (updated.length > MAX_SESSIONS_LOGGED) updated = updated.slice(-MAX_SESSIONS_LOGGED);
  await setStore({ sessions: updated });
}

async function onHeartbeat() {
  const store = await getStore();
  const now = Date.now();
  if (store.lastHeartbeat && now - store.lastHeartbeat > minutesToMs(HEARTBEAT_GAP_THRESHOLD_MIN)) {
    await reconstructGap(store.lastHeartbeat, now);
  }
  await setStore({ lastHeartbeat: now });
}

// Every place that activates a grant (a fresh decision, an override, an
// extend, a long-form renewal) needs the same three follow-up steps in the
// same order: unblock the site, make sure the tick alarm is running to
// track active time, and schedule the alarm that'll eventually finalize
// this grant. Centralizing it means those three steps can't drift out of
// sync at one call site without the others.
async function scheduleGrantEnforcement(hostname, grant) {
  await rebuildBlockRules();
  await ensureTickAlarm();
  chrome.alarms.create(`expire:${hostname}`, { when: grant.expiresAt });
}

async function maybeStopTickAlarm() {
  const { grants } = await getStore();
  if (Object.keys(grants).length === 0) chrome.alarms.clear(TICK_ALARM);
}

async function onTick() {
  const { grants } = await getStore();
  const hostnames = Object.keys(grants);
  if (hostnames.length === 0) {
    chrome.alarms.clear(TICK_ALARM);
    return;
  }
  let activeTab;
  try {
    [activeTab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  } catch {
    activeTab = null;
  }
  const activeHostname = activeTab ? hostnameFromUrl(activeTab.url || '') : null;
  let changed = false;
  for (const hostname of hostnames) {
    if (hostname === activeHostname) {
      grants[hostname].activeSeconds += TICK_PERIOD_MIN * 60;
      changed = true;
    }
  }
  if (changed) await setStore({ grants });
}

// DNR only intercepts real network navigations. Single-page sites (e.g. video
// sites navigating between videos via history.pushState) never fire one once
// a grant is active, so an expired/ended grant would otherwise leave any
// already-open tab on the site untouched until the user manually reloads or
// types a new URL. Force those tabs back to the blocked page immediately.
async function kickOutTabs(hostname) {
  let tabs;
  try {
    tabs = await chrome.tabs.query({ url: [`*://*.${hostname}/*`, `*://${hostname}/*`] });
  } catch {
    tabs = [];
  }
  for (const tab of tabs) {
    if (!tab.id || !tab.url) continue;
    const blockedUrl = chrome.runtime.getURL(
      `blocked.html?site=${encodeURIComponent(hostname)}&target=${encodeURIComponent(tab.url)}`
    );
    try {
      await chrome.tabs.update(tab.id, { url: blockedUrl });
    } catch {
      // tab may have been closed in the meantime — nothing to do
    }
  }
}

async function finalizeSession(hostname, endReason, { skipKickOut = false } = {}) {
  const store = await getStore();
  const grant = store.grants[hostname];
  if (!grant) return;

  const now = Date.now();
  const activeMinutes = grant.activeSeconds / 60;
  // Counts prior sessions only — this one hasn't been pushed to store.sessions yet.
  const recent = recentStatsFor(store.sessions, hostname, now, store.settings.frequencyWindowMin);
  const reward = computeGrantReward(activeMinutes, recent.sessionsInFrequencyWindow, !!grant.overridden, store.settings);

  // A grant discovered long past its own expiresAt means the service worker
  // wasn't running to track it accurately for some stretch of that window
  // (almost always: the extension was disabled) — activeSeconds is
  // undercounted, so the reward computed from it is too lenient. Still log
  // the session for visibility, but don't let a corrupted number train the
  // model — see isGrantStale in lib/background-helpers.js.
  const stale = isGrantStale(grant, now, STALE_GRANT_THRESHOLD_MIN);
  if (!stale) {
    const bandit = getBanditFor(store, hostname);
    bandit.update(grant.armIndex, grant.context, reward);
    store.banditState[hostname] = bandit.toJSON();
  }

  store.sessions.push({
    hostname,
    armIndex: grant.armIndex,
    durationMin: grant.durationMin,
    grantedAt: grant.grantedAt,
    endedAt: now,
    activeMinutes,
    reward,
    decision: 'grant',
    endReason,
    stale,
  });
  if (store.sessions.length > MAX_SESSIONS_LOGGED) {
    store.sessions = store.sessions.slice(-MAX_SESSIONS_LOGGED);
  }

  delete store.grants[hostname];

  // Per-navigation gating is the default with no automatic exceptions — but
  // a session this long is a strong enough signal to at least offer a way
  // out: for a short window, the blocked page will show an "extend" option
  // that costs the same wait-and-hold effort an override does. It's an
  // offer, not a grant — nothing changes until EXTEND_SESSION is actually
  // used.
  if (!grant.overridden && !grant.extended && activeMinutes >= store.settings.extremeLongFormMin) {
    store.extendEligible[hostname] = {
      context: grant.context,
      expiresAt: now + minutesToMs(store.settings.extendOfferWindowMin),
    };
  }

  await setStore({
    banditState: store.banditState,
    sessions: store.sessions,
    grants: store.grants,
    extendEligible: store.extendEligible,
  });
  await chrome.alarms.clear(`expire:${hostname}`);
  await rebuildBlockRules();
  if (!skipKickOut) await kickOutTabs(hostname);
  await maybeStopTickAlarm();
}

// Fires when a grant's timer runs out. Cutting off a 40-minute documentary
// the instant the clock hits zero is a worse interruption than the timer
// itself was ever meant to prevent — if you're still actively watching and
// you've already been engaged long enough to look like genuine long-form
// viewing (not compulsive scrolling), silently ask the bandit again instead
// of hard-kicking you out. It still gets a real say: heavier recent usage by
// then may well tip a fresh decision toward denying, and that's fine — it's
// just not an unconditional cutoff at the fixed mark.
async function handleExpiry(hostname) {
  const store = await getStore();
  const grant = store.grants[hostname];
  if (!grant) return;

  const longFormEngaged = isLongFormEngaged(grant.activeSeconds, grant.durationMin, store.settings.longFormDwellMin);
  let activeTab;
  try {
    [activeTab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  } catch {
    activeTab = null;
  }
  const stillWatching = longFormEngaged && activeTab && hostnameFromUrl(activeTab.url || '') === hostname;

  if (!stillWatching) {
    await finalizeSession(hostname, 'expired');
    return;
  }

  await finalizeSession(hostname, 'renewed', { skipKickOut: true });

  const fresh = await getStore();
  const now = Date.now();
  const recent = recentStatsFor(
    fresh.sessions,
    hostname,
    now,
    fresh.settings.frequencyWindowMin,
    fresh.settings.overrideWindowMin
  );
  const context = buildContext(new Date(now), recent);
  const bandit = getBanditFor(fresh, hostname);
  const { armIndex } = bandit.selectArm(context);
  const durationMin = fresh.settings.armDurationsMin[armIndex];

  if (durationMin === 0) {
    // The redraw denied — this is where sustained viewing finally does end.
    bandit.update(armIndex, context, fresh.settings.denyReward);
    fresh.banditState[hostname] = bandit.toJSON();
    fresh.sessions.push({
      hostname,
      armIndex,
      durationMin: 0,
      grantedAt: now,
      endedAt: now,
      activeMinutes: 0,
      reward: fresh.settings.denyReward,
      decision: 'deny',
      endReason: 'denied-on-renewal',
      context,
      targetUrl: activeTab.url,
    });
    if (fresh.sessions.length > MAX_SESSIONS_LOGGED) fresh.sessions = fresh.sessions.slice(-MAX_SESSIONS_LOGGED);
    await setStore({ banditState: fresh.banditState, sessions: fresh.sessions });
    await rebuildBlockRules();
    await kickOutTabs(hostname);
    return;
  }

  fresh.grants[hostname] = makeGrant(armIndex, durationMin, context, now, activeTab.url);
  await setStore({ grants: fresh.grants });
  await scheduleGrantEnforcement(hostname, fresh.grants[hostname]);
}

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === TICK_ALARM) {
    onTick();
  } else if (alarm.name === HEARTBEAT_ALARM) {
    onHeartbeat();
  } else if (alarm.name.startsWith('expire:')) {
    handleExpiry(alarm.name.slice('expire:'.length));
  }
});

// ---- core decision logic -------------------------------------------------

async function handleRequestAccess(hostname, targetUrl, { skipCooldown = false } = {}) {
  let store = await getStore();
  const now = Date.now();

  if (store.grants[hostname]) {
    if (isGrantStale(store.grants[hostname], now, STALE_GRANT_THRESHOLD_MIN)) {
      // The expire alarm that should have finalized this never fired in
      // time — most likely the extension was disabled while it was active.
      // Finalize it now (untrained, since its activeSeconds can't be
      // trusted — see finalizeSession) instead of treating a long-dead
      // grant as still live, which would otherwise block every future
      // decision for this site indefinitely.
      await finalizeSession(hostname, 'expired');
      store = await getStore();
    } else {
      return { granted: true, durationMin: store.grants[hostname].durationMin, targetUrl, alreadyGranted: true };
    }
  }

  const recent = recentStatsFor(
    store.sessions,
    hostname,
    now,
    store.settings.frequencyWindowMin,
    store.settings.overrideWindowMin
  );
  const trust = trustFor(store, hostname, now);
  const cooldownSec = applyTrustDiscount(computeCooldownSec(recent.avgRecentActiveMin, store.settings), trust, store.settings);
  const cooldownMs = cooldownSec * 1000;
  const last = store.lastRequestAt[hostname] || 0;
  if (!skipCooldown && now - last < cooldownMs) {
    return { granted: false, cooldown: true, retryAtMs: last + cooldownMs, cooldownHoldMs: store.settings.overrideHoldMs };
  }
  store.lastRequestAt[hostname] = now;

  const context = buildContext(new Date(now), recent);
  const bandit = getBanditFor(store, hostname);
  const { armIndex, scores } = bandit.selectArm(context);
  const durationMin = store.settings.armDurationsMin[armIndex];

  if (durationMin === 0) {
    // Not accessing is the rewarded outcome by default — this is retroactively
    // flipped to a penalty in the OVERRIDE_DENY handler if you end up
    // overriding this specific denial.
    bandit.update(armIndex, context, store.settings.denyReward);
    store.banditState[hostname] = bandit.toJSON();
    store.sessions.push({
      hostname,
      armIndex,
      durationMin: 0,
      grantedAt: now,
      endedAt: now,
      activeMinutes: 0,
      reward: store.settings.denyReward,
      decision: 'deny',
      endReason: 'denied',
      context,
      targetUrl,
    });
    if (store.sessions.length > MAX_SESSIONS_LOGGED) store.sessions = store.sessions.slice(-MAX_SESSIONS_LOGGED);
    await setStore({
      banditState: store.banditState,
      sessions: store.sessions,
      lastRequestAt: store.lastRequestAt,
    });
    const denyStreak = recentDenyStreak(store.sessions, hostname);
    const overrideDelaySec = applyTrustDiscount(
      computeOverrideDelaySec(recent.overridesInWindow, denyStreak, store.settings),
      trust,
      store.settings
    );
    return { granted: false, scores, overrideDelaySec, overrideHoldMs: store.settings.overrideHoldMs };
  }

  store.grants[hostname] = makeGrant(armIndex, durationMin, context, now, targetUrl);
  await setStore({ grants: store.grants, lastRequestAt: store.lastRequestAt });
  await scheduleGrantEnforcement(hostname, store.grants[hostname]);

  return { granted: true, durationMin, targetUrl, scores };
}

// There's no way to tell from context alone whether a denial blocked
// mindless scrolling or something genuinely needed — only the retroactive
// penalty on the deny decision, plus a grant and a grace/trust bump, can
// correct a wrongful denial after the fact. See the override wait/hold
// mechanics in blocked.js for the effort required to reach this at all.
async function handleOverrideDeny(hostname, targetUrl) {
  const store = await getStore();
  const denySession = [...store.sessions]
    .reverse()
    .find((s) => s.hostname === hostname && s.decision === 'deny' && !s.overridden && s.context);

  if (!denySession) {
    return { ok: false, error: 'no recent denial to override' };
  }

  const bandit = getBanditFor(store, hostname);
  bandit.update(denySession.armIndex, denySession.context, -store.settings.denyOverridePenalty);
  store.banditState[hostname] = bandit.toJSON();
  denySession.overridden = true;
  denySession.reward = -store.settings.denyOverridePenalty;

  // Grant the smallest available duration anyway.
  const overrideArmIndex = store.settings.armDurationsMin.findIndex((d) => d > 0);
  const armIndex = overrideArmIndex >= 0 ? overrideArmIndex : 0;
  const durationMin = overrideArmIndex >= 0 ? store.settings.armDurationsMin[overrideArmIndex] : 5;
  const now = Date.now();
  store.grants[hostname] = makeGrant(armIndex, durationMin, denySession.context, now, targetUrl || denySession.targetUrl, {
    overridden: true,
  });
  // The effort of getting through the wait and the hold should buy more
  // than the one page it was spent on — suspend per-navigation re-gating
  // on this site for a grace window afterward. The hop count is generous
  // enough that this behaves like free browsing for the window's duration
  // in practice (see consumeGrace).
  store.grace[hostname] = { expiresAt: now + minutesToMs(store.settings.overrideGraceMin), hopsRemaining: store.settings.overrideGraceHopCount };

  // Bank trust credit too, so near-future access on this site stays easier
  // for a while after the grace window itself lapses — decaying gradually
  // (decayedTrust) rather than snapping back to full friction the instant
  // grace ends.
  const priorTrust = trustFor(store, hostname, now);
  store.trust[hostname] = { value: Math.min(1, priorTrust + store.settings.trustOverrideBoost), updatedAt: now };

  await setStore({
    banditState: store.banditState,
    sessions: store.sessions,
    grants: store.grants,
    grace: store.grace,
    trust: store.trust,
  });
  await scheduleGrantEnforcement(hostname, store.grants[hostname]);

  return { granted: true, durationMin, targetUrl: store.grants[hostname].targetUrl, overridden: true };
}

// Reuses the largest configured arm so the bandit still learns from this
// session like any other grant — extending isn't correcting a wrong
// decision the way an override is, so it doesn't carry the extra
// overrideSessionPenalty; the duration penalty on a deliberately long
// grant already reflects its cost.
async function handleExtendSession(hostname, targetUrl) {
  const store = await getStore();
  const now = Date.now();
  const eligible = store.extendEligible[hostname];

  if (!eligible || now >= eligible.expiresAt) {
    return { ok: false, error: 'no extend offer available' };
  }
  delete store.extendEligible[hostname];

  const armIndex = store.settings.armDurationsMin.length - 1;
  const durationMin = store.settings.extendGrantMin;
  store.grants[hostname] = makeGrant(armIndex, durationMin, eligible.context, now, targetUrl, { extended: true });

  // The point of spending the effort: skip the redirect that's about to
  // happen. The credit is deliberately scarce — a handful of hops at most,
  // diminishing with every one spent (see consumeGrace) — unlike
  // override's grace, which is generous enough to feel like free browsing.
  store.grace[hostname] = {
    expiresAt: now + minutesToMs(store.settings.extendGraceMin),
    hopsRemaining: store.settings.extendHopCount,
  };

  await setStore({ grants: store.grants, grace: store.grace, extendEligible: store.extendEligible });
  await scheduleGrantEnforcement(hostname, store.grants[hostname]);

  return { granted: true, durationMin, targetUrl };
}

// ---- messaging ------------------------------------------------------------

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    try {
      switch (msg.type) {
        case 'REQUEST_ACCESS': {
          const result = await handleRequestAccess(msg.hostname, msg.targetUrl);
          sendResponse(result);
          break;
        }
        case 'OVERRIDE_COOLDOWN': {
          // The cooldown wait, not a denial, was the thing standing between
          // you and asking — spending effort (a hold, no separate delay: the
          // wait itself is exactly what this replaces) skips straight to a
          // real, fair decision instead of leaving "disable the extension" as
          // the only way around it. Still goes through the normal bandit
          // decision — this doesn't guarantee access, just the chance to ask.
          const result = await handleRequestAccess(msg.hostname, msg.targetUrl, { skipCooldown: true });
          sendResponse(result);
          break;
        }
        case 'END_SESSION': {
          await finalizeSession(msg.hostname, msg.reason || 'manual');
          sendResponse({ ok: true });
          break;
        }
        case 'OVERRIDE_DENY': {
          const result = await handleOverrideDeny(msg.hostname, msg.targetUrl);
          sendResponse(result);
          break;
        }
        case 'EXTEND_SESSION': {
          const result = await handleExtendSession(msg.hostname, msg.targetUrl);
          sendResponse(result);
          break;
        }
        case 'GET_EXTEND_ELIGIBILITY': {
          const store = await getStore();
          const eligible = store.extendEligible[msg.hostname];
          const now = Date.now();
          sendResponse({ eligible: !!(eligible && now < eligible.expiresAt), holdMs: store.settings.overrideHoldMs });
          break;
        }
        case 'ADD_SITE': {
          const store = await getStore();
          if (!store.sites.some((s) => s.hostname === msg.hostname)) {
            store.sites.push({ hostname: msg.hostname, addedAt: Date.now() });
            await setStore({ sites: store.sites });
            await rebuildBlockRules();
            await rebuildContentScripts();
            await injectIntoOpenTabs(msg.hostname);
          }
          sendResponse({ ok: true, sites: store.sites });
          break;
        }
        case 'REMOVE_SITE': {
          const store = await getStore();
          store.sites = store.sites.filter((s) => s.hostname !== msg.hostname);
          delete store.grants[msg.hostname];
          delete store.grace[msg.hostname];
          delete store.trust[msg.hostname];
          delete store.extendEligible[msg.hostname];
          await setStore({
            sites: store.sites,
            grants: store.grants,
            grace: store.grace,
            trust: store.trust,
            extendEligible: store.extendEligible,
          });
          await chrome.alarms.clear(`expire:${msg.hostname}`);
          await rebuildBlockRules();
          await rebuildContentScripts();
          sendResponse({ ok: true, sites: store.sites });
          break;
        }
        case 'CHECK_ACCESS': {
          const store = await getStore();
          const now = Date.now();
          // A grant that's still sitting in storage isn't necessarily still
          // valid — its expire alarm may not have fired yet (delayed, or
          // missed entirely while the extension was disabled). Unlike a
          // fresh handleRequestAccess call, this runs on every page load and
          // every detected navigation, so it's the one place that would
          // otherwise silently keep treating a long-dead grant as live
          // indefinitely - checking staleness here, not just existence,
          // closes that gap directly instead of relying on some other event
          // to eventually notice.
          const grant = store.grants[msg.hostname];
          const hasGrant = !!grant && !isGrantStale(grant, now, STALE_GRANT_THRESHOLD_MIN);
          let inGrace;
          if (msg.consume) {
            // A navigation is actually about to spend the credit — decrement
            // it (see consumeGrace) rather than just checking it, so a grace
            // window can't be stretched across more hops than it was earned for.
            const result = consumeGrace(store.grace[msg.hostname], now);
            inGrace = result.allowed;
            if (result.allowed) {
              if (result.next) store.grace[msg.hostname] = result.next;
              else delete store.grace[msg.hostname];
              await setStore({ grace: store.grace });
            }
          } else {
            // Non-destructive peek (e.g. initial page load) — don't spend a hop
            // just for checking whether the page should load at all.
            const entry = store.grace[msg.hostname];
            inGrace = !!(entry && now < entry.expiresAt && entry.hopsRemaining > 0);
          }
          // `granted` covers a normal page-level grant OR an active grace
          // credit — either lets a freshly loaded page through. `grace` is
          // reported separately: only it should suspend per-navigation
          // re-gating on the *next* click; a plain grant existing shouldn't,
          // since every new navigation still needs its own decision by default.
          sendResponse({ granted: hasGrant || inGrace, grace: inGrace });
          break;
        }
        case 'GET_STATUS': {
          const store = await getStore();
          const now = Date.now();
          const grant = store.grants[msg.hostname];
          const isManaged = store.sites.some((s) => s.hostname === msg.hostname);
          const recent = recentStatsFor(store.sessions, msg.hostname, now);
          const trust = trustFor(store, msg.hostname, now);
          const cooldownMs = applyTrustDiscount(computeCooldownSec(recent.avgRecentActiveMin, store.settings), trust, store.settings) * 1000;
          const last = store.lastRequestAt[msg.hostname] || 0;
          sendResponse({
            isManaged,
            grant: grant ? { ...grant, remainingMs: grant.expiresAt - Date.now() } : null,
            cooldownRemainingMs: Math.max(0, last + cooldownMs - Date.now()),
            sites: store.sites,
          });
          break;
        }
        case 'GET_SESSIONS': {
          const store = await getStore();
          sendResponse({ sessions: store.sessions.slice().reverse() });
          break;
        }
        case 'GET_SETTINGS': {
          const store = await getStore();
          sendResponse({ settings: store.settings });
          break;
        }
        case 'SET_SETTINGS': {
          const store = await getStore();
          await setStore({ settings: { ...store.settings, ...msg.settings } });
          sendResponse({ ok: true });
          break;
        }
        case 'RESET_BANDIT': {
          const store = await getStore();
          if (msg.hostname) delete store.banditState[msg.hostname];
          else store.banditState = {};
          await setStore({ banditState: store.banditState });
          sendResponse({ ok: true });
          break;
        }
        case 'CLEAR_SESSIONS': {
          await setStore({ sessions: [] });
          sendResponse({ ok: true });
          break;
        }
        case 'GET_BANDIT_DEBUG': {
          const store = await getStore();
          const now = Date.now();
          const recent = recentStatsFor(store.sessions, msg.hostname, now);
          const context = buildContext(new Date(), recent);
          const bandit = getBanditFor(store, msg.hostname);
          const scores = bandit.arms.map((a, i) => ({ durationMin: store.settings.armDurationsMin[i], ...a.score(context, store.settings.alpha) }));
          sendResponse({ context, scores, trust: trustFor(store, msg.hostname, now) });
          break;
        }
        default:
          sendResponse({ error: `unknown message type ${msg.type}` });
      }
    } catch (err) {
      // Without this, an exception thrown anywhere above (a rejected
      // chrome.* call, a bug in a handler) would skip its sendResponse
      // entirely, and the caller's `await chrome.runtime.sendMessage(...)`
      // would hang until Chrome eventually reports "the message port
      // closed" - a stuck "Thinking..."/"Asking..." with no real error
      // surfaced. Report it immediately instead.
      console.error(`[background] ${msg.type} failed:`, err);
      sendResponse({ error: err instanceof Error ? err.message : String(err) });
    }
  })();
  return true; // keep the message channel open for the async response
});

chrome.runtime.onInstalled.addListener(async () => {
  const store = await getStore();
  await setStore({ settings: store.settings, lastHeartbeat: store.lastHeartbeat || Date.now() });
  await rebuildBlockRules();
  await rebuildContentScripts();
  await ensureHeartbeatAlarm();
});
