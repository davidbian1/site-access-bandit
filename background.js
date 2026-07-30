import { LinUCB, FEATURE_DIM } from './lib/linucb.js';
import {
  TICK_PERIOD_MIN,
  MAX_SESSIONS_LOGGED,
  defaultSettings,
  hostnameFromUrl,
  buildContext,
  computeGrantReward,
  computeCooldownSec,
  computeOverrideDelaySec,
  recentDenyStreak,
  decayedTrust,
  applyTrustDiscount,
} from './lib/config.js';

const TICK_ALARM = 'tick';

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
    'ruleIds',
    'lastRequestAt',
    'nextRuleId',
  ]);
  return {
    sites: data.sites || [],
    settings: { ...defaultSettings(), ...(data.settings || {}) },
    banditState: data.banditState || {},
    sessions: data.sessions || [],
    grants: data.grants || {},
    grace: data.grace || {},
    trust: data.trust || {},
    ruleIds: data.ruleIds || {},
    lastRequestAt: data.lastRequestAt || {},
    nextRuleId: data.nextRuleId || 1,
  };
}

function trustFor(store, hostname, now) {
  return decayedTrust(store.trust[hostname], now, store.settings.trustHalfLifeMin);
}

async function setStore(partial) {
  await chrome.storage.local.set(partial);
}

function getBandit(banditState, hostname, alpha, nArms) {
  const saved = banditState[hostname];
  // If the arm count changed (user edited arm durations in settings), the old
  // per-arm state no longer lines up with the new arms — start fresh for this site.
  if (saved && saved.arms.length === nArms) return LinUCB.fromJSON({ ...saved, alpha });
  return new LinUCB(nArms, FEATURE_DIM, alpha);
}

function makeGrant(armIndex, durationMin, context, now, targetUrl, extra = {}) {
  return {
    armIndex,
    durationMin,
    context,
    grantedAt: now,
    expiresAt: now + durationMin * 60 * 1000,
    activeSeconds: 0,
    targetUrl,
    ...extra,
  };
}

function recentStatsFor(sessions, hostname, nowMs, frequencyWindowMin = 0, overrideWindowMin = 0) {
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

// ---- declarativeNetRequest rule management ----------------------------

function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

async function ruleIdFor(hostname, ruleIds, nextRuleId) {
  if (ruleIds[hostname]) return { id: ruleIds[hostname], ruleIds, nextRuleId };
  const id = nextRuleId;
  ruleIds[hostname] = id;
  return { id, ruleIds, nextRuleId: nextRuleId + 1 };
}

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
  let tabs = [];
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
  let tabs = [];
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

  const activeMinutes = grant.activeSeconds / 60;
  // Counts prior sessions only — this one hasn't been pushed to store.sessions yet.
  const recent = recentStatsFor(store.sessions, hostname, Date.now(), store.settings.frequencyWindowMin);
  const reward = computeGrantReward(activeMinutes, recent.sessionsInFrequencyWindow, !!grant.overridden, store.settings);

  const bandit = getBandit(store.banditState, hostname, store.settings.alpha, store.settings.armDurationsMin.length);
  bandit.update(grant.armIndex, grant.context, reward);
  store.banditState[hostname] = bandit.toJSON();

  store.sessions.push({
    hostname,
    armIndex: grant.armIndex,
    durationMin: grant.durationMin,
    grantedAt: grant.grantedAt,
    endedAt: Date.now(),
    activeMinutes,
    reward,
    decision: 'grant',
    endReason,
  });
  if (store.sessions.length > MAX_SESSIONS_LOGGED) {
    store.sessions = store.sessions.slice(-MAX_SESSIONS_LOGGED);
  }

  delete store.grants[hostname];

  // A qualifying long-form session is a real engagement signal, same spirit
  // as an override — bank the same grace/trust credit (smaller, since it's
  // passive rather than a deliberate costly action) so it buys more than
  // just the one dwell-based pass-through content.js already grants: some
  // slack for what you click next too, not just what you just watched.
  const now = Date.now();
  if (!grant.overridden && activeMinutes >= store.settings.longFormDwellMin) {
    store.grace[hostname] = Math.max(store.grace[hostname] || 0, now + store.settings.longFormGraceMin * 60 * 1000);
    const priorTrust = trustFor(store, hostname, now);
    store.trust[hostname] = { value: Math.min(1, priorTrust + store.settings.longFormTrustBoost), updatedAt: now };
  }

  await setStore({
    banditState: store.banditState,
    sessions: store.sessions,
    grants: store.grants,
    grace: store.grace,
    trust: store.trust,
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

  const longFormEngaged = grant.activeSeconds >= store.settings.longFormDwellMin * 60;
  let activeTab = null;
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
  const bandit = getBandit(fresh.banditState, hostname, fresh.settings.alpha, fresh.settings.armDurationsMin.length);
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
  await rebuildBlockRules();
  await ensureTickAlarm();
  chrome.alarms.create(`expire:${hostname}`, { when: fresh.grants[hostname].expiresAt });
}

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === TICK_ALARM) {
    onTick();
  } else if (alarm.name.startsWith('expire:')) {
    handleExpiry(alarm.name.slice('expire:'.length));
  }
});

// ---- core decision logic -------------------------------------------------

async function handleRequestAccess(hostname, targetUrl) {
  const store = await getStore();
  const now = Date.now();

  if (store.grants[hostname]) {
    return { granted: true, durationMin: store.grants[hostname].durationMin, targetUrl, alreadyGranted: true };
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
  if (now - last < cooldownMs) {
    return { granted: false, cooldown: true, retryAtMs: last + cooldownMs };
  }
  store.lastRequestAt[hostname] = now;

  const context = buildContext(new Date(now), recent);
  const bandit = getBandit(store.banditState, hostname, store.settings.alpha, store.settings.armDurationsMin.length);
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
  await rebuildBlockRules();
  await ensureTickAlarm();
  chrome.alarms.create(`expire:${hostname}`, { when: store.grants[hostname].expiresAt });

  return { granted: true, durationMin, targetUrl, scores };
}

// ---- messaging ------------------------------------------------------------

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    switch (msg.type) {
      case 'REQUEST_ACCESS': {
        const result = await handleRequestAccess(msg.hostname, msg.targetUrl);
        sendResponse(result);
        break;
      }
      case 'END_SESSION': {
        await finalizeSession(msg.hostname, msg.reason || 'manual');
        sendResponse({ ok: true });
        break;
      }
      case 'OVERRIDE_DENY': {
        const store = await getStore();
        const hostname = msg.hostname;
        const denySession = [...store.sessions]
          .reverse()
          .find((s) => s.hostname === hostname && s.decision === 'deny' && !s.overridden && s.context);

        if (!denySession) {
          sendResponse({ ok: false, error: 'no recent denial to override' });
          break;
        }

        // Retroactively penalize the deny decision that was just made — this
        // is the only signal that can ever correct a wrongful denial, since
        // there's no way to tell from context alone that this one mattered.
        const bandit = getBandit(store.banditState, hostname, store.settings.alpha, store.settings.armDurationsMin.length);
        bandit.update(denySession.armIndex, denySession.context, -store.settings.denyOverridePenalty);
        store.banditState[hostname] = bandit.toJSON();
        denySession.overridden = true;
        denySession.reward = -store.settings.denyOverridePenalty;

        // Grant the smallest available duration anyway.
        const overrideArmIndex = store.settings.armDurationsMin.findIndex((d) => d > 0);
        const armIndex = overrideArmIndex >= 0 ? overrideArmIndex : 0;
        const durationMin = overrideArmIndex >= 0 ? store.settings.armDurationsMin[overrideArmIndex] : 5;
        const now = Date.now();
        store.grants[hostname] = makeGrant(armIndex, durationMin, denySession.context, now, msg.targetUrl || denySession.targetUrl, {
          overridden: true,
        });
        // The effort of getting through the wait and the hold should buy more
        // than the one page it was spent on — suspend per-navigation
        // re-gating on this site for a grace window afterward.
        store.grace[hostname] = now + store.settings.overrideGraceMin * 60 * 1000;

        // Bank trust credit too, so near-future access on this site stays
        // easier for a while after the grace window itself lapses — decaying
        // gradually (decayedTrust) rather than snapping back to full
        // friction the instant grace ends.
        const priorTrust = trustFor(store, hostname, now);
        store.trust[hostname] = { value: Math.min(1, priorTrust + store.settings.trustOverrideBoost), updatedAt: now };

        await setStore({
          banditState: store.banditState,
          sessions: store.sessions,
          grants: store.grants,
          grace: store.grace,
          trust: store.trust,
        });
        await rebuildBlockRules();
        await ensureTickAlarm();
        chrome.alarms.create(`expire:${hostname}`, { when: store.grants[hostname].expiresAt });

        sendResponse({ granted: true, durationMin, targetUrl: store.grants[hostname].targetUrl, overridden: true });
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
        await setStore({ sites: store.sites, grants: store.grants, grace: store.grace, trust: store.trust });
        await chrome.alarms.clear(`expire:${msg.hostname}`);
        await rebuildBlockRules();
        await rebuildContentScripts();
        sendResponse({ ok: true, sites: store.sites });
        break;
      }
      case 'CHECK_ACCESS': {
        const store = await getStore();
        const now = Date.now();
        const hasGrant = !!store.grants[msg.hostname];
        const inGrace = now < (store.grace[msg.hostname] || 0);
        // dwellMs, if provided, is how long content.js measured you staying
        // on the page you're navigating away from — long enough and this
        // navigation is treated like a grace-covered one, so a genuinely
        // long-form video doesn't re-trigger the gate on "what's next" the
        // way a string of short clips still does.
        const longFormDwell = typeof msg.dwellMs === 'number' && msg.dwellMs >= store.settings.longFormDwellMin * 60000;
        // `granted` covers a normal page-level grant OR an active grace
        // window — either lets a freshly loaded page through. `grace` and
        // `longFormDwell` are reported separately: only those two should
        // suspend per-navigation re-gating on the *next* click; a plain
        // grant existing shouldn't, since every new navigation is still
        // meant to need its own decision outside of those cases.
        sendResponse({ granted: hasGrant || inGrace, grace: inGrace, longFormDwell });
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
        const bandit = getBandit(store.banditState, msg.hostname, store.settings.alpha, store.settings.armDurationsMin.length);
        const scores = bandit.arms.map((a, i) => ({ durationMin: store.settings.armDurationsMin[i], ...a.score(context, store.settings.alpha) }));
        sendResponse({ context, scores, trust: trustFor(store, msg.hostname, now) });
        break;
      }
      default:
        sendResponse({ error: `unknown message type ${msg.type}` });
    }
  })();
  return true; // keep the message channel open for the async response
});

chrome.runtime.onInstalled.addListener(async () => {
  const store = await getStore();
  await setStore({ settings: store.settings });
  await rebuildBlockRules();
  await rebuildContentScripts();
});
