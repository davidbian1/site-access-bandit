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
  FREE_TIME_DURATIONS_MIN,
  eligibleFreeTimeArmIndices,
  computeFreeTimeReward,
  AUTH_SUBDOMAIN_PREFIXES,
  authSubdomainHostnames,
  isAuthSubdomain,
  isSameSubUrl,
} from './lib/config.js';
import {
  escapeRegex,
  ruleIdFor,
  makeGrant,
  recentStatsFor,
  isGrantStale,
  getBanditFor,
  estimateExposureMinutes,
  globalFatigueStats,
  globalFrictionCount24h,
  getFreeTimeBandit,
} from './lib/background-helpers.js';

const TICK_ALARM = 'tick';
const HEARTBEAT_ALARM = 'heartbeat';
const FREE_TIME_EXPIRE_ALARM = 'freeTimeExpire';

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
    'freeTimeUntil',
    'freeTimeWindows',
    'freeTimeBanditState',
    'lastFreeTimeSuggestedAt',
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
    freeTimeUntil: data.freeTimeUntil || 0,
    freeTimeWindows: data.freeTimeWindows || [],
    freeTimeBanditState: data.freeTimeBanditState || null,
    lastFreeTimeSuggestedAt: data.lastFreeTimeSuggestedAt || 0,
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
  const { sites, grants, ruleIds, nextRuleId, freeTimeUntil } = await getStore();
  const existing = await chrome.declarativeNetRequest.getDynamicRules();
  const removeRuleIds = existing.map((r) => r.id);

  let nextId = nextRuleId;
  const addRules = [];
  // Free time suspends gating entirely, at the network level, not just at
  // the CHECK_ACCESS/handleRequestAccess layer — a fresh top-level
  // navigation to any managed site during a free-time window should never
  // hit blocked.html at all, which means no site gets a block rule while
  // one is active. See the "free time" section below for why this exists.
  const freeTimeActive = freeTimeUntil && Date.now() < freeTimeUntil;
  for (const site of freeTimeActive ? [] : sites) {
    if (grants[site.hostname]) continue; // currently granted — leave unblocked
    const assign = await ruleIdFor(site.hostname, ruleIds, nextId);
    nextId = assign.nextRuleId;
    const escaped = escapeRegex(site.hostname);

    // A higher-priority `allow` rule for known identity-subdomain hops
    // (accounts.<site>, login.<site>, ...) — evaluated before the redirect
    // rule below, so signing in never gets diverted to blocked.html mid-
    // handshake. DNR's regexFilter runs on RE2, which has no negative
    // lookahead, so this has to be a separate, explicitly-allowed rule
    // rather than an exclusion baked into the redirect rule's own pattern.
    // See isAuthSubdomain's comment in lib/config.js for why.
    const authAssign = await ruleIdFor(`auth:${site.hostname}`, ruleIds, nextId);
    nextId = authAssign.nextRuleId;
    addRules.push({
      id: authAssign.id,
      priority: 2,
      condition: {
        regexFilter: `^https?://(${AUTH_SUBDOMAIN_PREFIXES.join('|')})\\.${escaped}(:[0-9]+)?(/.*)?$`,
        resourceTypes: ['main_frame'],
      },
      action: { type: 'allow' },
    });

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
          // `\0` (the full matched URL) is inserted raw here — DNR's
          // regexSubstitution has no way to percent-encode a backreference,
          // so an `&`/`#` in the real URL's own query string could corrupt
          // where the `target` param ends. That's a data-integrity wrinkle,
          // not a security hole on its own — blocked.js treats `target` as
          // untrusted input regardless of source and validates it against
          // `site` before ever navigating to it (isTrustedTarget in
          // lib/config.js), so a corrupted value here just falls back to
          // the site's own root rather than going anywhere unexpected.
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
    // Identity-subdomain hops (accounts.<site> etc.) are excluded the same
    // way the DNR allow rule exempts them — enforcement here never even
    // starts on a sign-in redirect, rather than starting and then having
    // to recognize it should back off. See isAuthSubdomain in lib/config.js.
    const excludeMatches = authSubdomainHostnames(site.hostname).map((h) => `*://${h}/*`);
    // MAIN world: patches the page's real history.pushState/replaceState so
    // client-side routing (e.g. video-to-video, short-form swipe feeds) is
    // actually observed — an isolated-world override never sees calls made
    // by the page's own script.
    scripts.push({
      id: `${CONTENT_SCRIPT_ID_PREFIX}main-${site.hostname}`,
      matches,
      excludeMatches,
      js: ['content-main.js'],
      runAt: 'document_start',
      world: 'MAIN',
    });
    // Isolated world: has chrome.* API access, does the actual enforcement.
    scripts.push({
      id: `${CONTENT_SCRIPT_ID_PREFIX}${site.hostname}`,
      matches,
      excludeMatches,
      js: ['content.js'],
      runAt: 'document_start',
    });
  }
  await chrome.scripting.registerContentScripts(scripts);
}

// Whether content.js is already alive in a tab — chrome.tabs.sendMessage
// rejects when nothing on the other end is listening. Used to make
// injection idempotent (safe to call redundantly) rather than trying to
// infer *why* a tab might be missing it — there's no reliable signal that
// distinguishes "this tab predates the site being added," "the extension
// was just re-enabled," or any other reason from each other; checking
// reality directly sidesteps needing to.
async function hasLiveContentScript(tabId) {
  try {
    await chrome.tabs.sendMessage(tabId, { type: 'PING' });
    return true;
  } catch {
    return false;
  }
}

async function injectContentScripts(tabId) {
  await chrome.scripting.executeScript({ target: { tabId }, files: ['content-main.js'], world: 'MAIN' });
  await chrome.scripting.executeScript({ target: { tabId }, files: ['content.js'] });
}

// Registering a content script only affects future navigations/frames, not
// tabs already sitting on the site — inject into those immediately so a
// freshly-managed site (or one whose tabs lost enforcement for any other
// reason — see reconcileOpenTabs) is covered without requiring a manual
// reload.
async function injectIntoOpenTabs(hostname) {
  let tabs;
  try {
    tabs = await chrome.tabs.query({ url: [`*://*.${hostname}/*`, `*://${hostname}/*`] });
  } catch {
    tabs = [];
  }
  for (const tab of tabs) {
    if (!tab.id) continue;
    // Same identity-subdomain exemption as rebuildContentScripts — a tab
    // already sitting on a sign-in hop shouldn't get enforcement injected
    // into it either.
    if (isAuthSubdomain(hostnameFromUrl(tab.url || '') || '', hostname)) continue;
    try {
      if (await hasLiveContentScript(tab.id)) continue;
      await injectContentScripts(tab.id);
    } catch {
      // tab may not be script-injectable (e.g. a chrome:// page) — skip
    }
  }
}

// A tab that was already open and rendered when the extension got disabled
// has no way to notice it's been re-enabled on its own — content script
// *registration* only affects future navigations, and a tab that was
// sitting on a managed site the whole time might never navigate again
// (the user could just keep watching in the same tab indefinitely). There
// is no reliable "I was just re-enabled" signal available to a service
// worker (a cold start looks the same whether caused by re-enabling, the
// computer waking up, or ordinary MV3 idle unloading) — so instead of
// trying to detect the cause, this reconciles every managed site's open
// tabs against reality on every service worker start. hasLiveContentScript
// makes that safe to run unconditionally: a tab that was never actually
// disconnected just answers the PING and gets left alone.
async function reconcileOpenTabs() {
  const { sites } = await getStore();
  for (const site of sites) await injectIntoOpenTabs(site.hostname);
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
    // A tab mid-sign-in shouldn't be kicked to blocked.html just because a
    // grant on the main site ended — see isAuthSubdomain in lib/config.js.
    if (isAuthSubdomain(hostnameFromUrl(tab.url) || '', hostname)) continue;
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

async function finalizeSession(hostname, endReason) {
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
  await kickOutTabs(hostname);
  await maybeStopTickAlarm();
}

// Fires when a grant's timer runs out. A grant covers exactly the one
// sub-URL it was made for (see isSameSubUrl in lib/config.js) — cutting
// that off the instant the clock hits zero is a worse interruption than
// the timer was ever meant to prevent, so as long as the active tab is
// still showing that exact page, this silently extends the grant rather
// than asking the bandit again (which could still deny) or hard-cutting.
// No cap on how many times this can renew: the moment the tab moves to
// anything else — a different video, a different tab, loses focus
// entirely — CHECK_ACCESS's own sub-URL check re-gates it immediately and
// normally, which is deliberately the strict default here (see DESIGN.md's
// "Grant scope" section for the full reasoning).
async function handleExpiry(hostname) {
  const store = await getStore();
  const grant = store.grants[hostname];
  if (!grant) return;

  let activeTab;
  try {
    [activeTab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  } catch {
    activeTab = null;
  }
  const stillOnGrantedPage = !!activeTab && isSameSubUrl(activeTab.url || '', grant.targetUrl);

  if (!stillOnGrantedPage) {
    await finalizeSession(hostname, 'expired');
    return;
  }

  grant.expiresAt = Date.now() + minutesToMs(grant.durationMin);
  await setStore({ grants: store.grants });
  chrome.alarms.create(`expire:${hostname}`, { when: grant.expiresAt });
}

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === TICK_ALARM) {
    onTick();
  } else if (alarm.name === HEARTBEAT_ALARM) {
    onHeartbeat();
  } else if (alarm.name.startsWith('expire:')) {
    handleExpiry(alarm.name.slice('expire:'.length));
  } else if (alarm.name === FREE_TIME_EXPIRE_ALARM) {
    rebuildBlockRules(); // freeTimeUntil has passed; restores normal gating
  } else if (alarm.name.startsWith('freeTimeFollowup:')) {
    onFreeTimeFollowup(alarm.name.slice('freeTimeFollowup:'.length));
  }
});

// ---- free time --------------------------------------------------------
// A proactive, global suspension of gating across every managed site,
// initiated by the user rather than decided by the bandit — see
// DEFAULT_FREE_TIME_MAX_MIN's comment in lib/config.js for the full
// rationale (this replaced an earlier design that blocked every site
// instead — see docs/adr/0003's Update section). Its *duration* is a
// bandit decision, same as a site's grant duration.

function freeTimeContext(store, now) {
  const fatigue = globalFatigueStats(store.sessions, now);
  const context = buildContext(new Date(now), { sessionsLast24h: fatigue.sessionsLast24h, avgRecentActiveMin: fatigue.totalActiveMinLast24h });
  return { context, fatigue };
}

// armIndex should come from GET_FREE_TIME_SUGGESTION (the popup never
// sends a raw minute count) — falls back to the shortest eligible arm if
// it's missing or no longer valid (e.g. freeTimeMaxMin shrank since the
// suggestion was fetched), rather than rejecting the request outright.
async function startFreeTime(armIndex) {
  let store = await getStore();
  const now = Date.now();
  const eligible = eligibleFreeTimeArmIndices(store.settings);
  const chosenArmIndex = eligible.includes(armIndex) ? armIndex : eligible[0];
  if (chosenArmIndex === undefined) {
    return { ok: false, error: 'no free-time duration fits the configured cap' };
  }
  const { context } = freeTimeContext(store, now);
  const minutes = FREE_TIME_DURATIONS_MIN[chosenArmIndex];
  const freeTimeUntil = now + minutesToMs(minutes);

  // A grant already in progress is still a real bandit decision that
  // happened — finalize it so it trains the site bandit normally on the
  // usage up to this point, rather than leaving it dangling under a
  // window where gating doesn't apply anyway.
  for (const hostname of Object.keys(store.grants)) {
    await finalizeSession(hostname, 'free-time-started');
  }

  store = await getStore();
  store.freeTimeWindows.push({
    startedAt: now,
    plannedMinutes: minutes,
    endsAt: freeTimeUntil,
    endedEarly: false,
    armIndex: chosenArmIndex,
    context,
    trained: false,
  });
  if (store.freeTimeWindows.length > MAX_SESSIONS_LOGGED) store.freeTimeWindows = store.freeTimeWindows.slice(-MAX_SESSIONS_LOGGED);
  await setStore({ freeTimeUntil, freeTimeWindows: store.freeTimeWindows });
  await rebuildBlockRules(); // clears every site's block rule immediately, not just on the next unrelated rebuild

  // Two alarms: one restores normal gating right at the natural end (fixed
  // name — a second free-time window starting before the first ends just
  // reschedules this one to the new end time, which is exactly what should
  // happen), the other finalizes the bandit reward once there's been
  // enough time to tell whether the window actually held — named per
  // window so a second window starting inside the first one's too-short
  // check doesn't clobber the first one's pending training.
  chrome.alarms.create(FREE_TIME_EXPIRE_ALARM, { when: freeTimeUntil });
  chrome.alarms.create(`freeTimeFollowup:${now}`, { when: freeTimeUntil + minutesToMs(store.settings.freeTimeTooShortWindowMin) });

  return { ok: true, freeTimeUntil, minutes, armIndex: chosenArmIndex };
}

// Ends free time early — deliberately frictionless, no wait or hold,
// unlike every other "back out of this" control in the extension. Choosing
// to re-enable your own gating early is a disciplined act, not a relapse;
// see DEFAULT_FREE_TIME_MAX_MIN's comment in lib/config.js. Still trains
// the free-time-duration bandit: how much of the window was actually used
// before ending it is real calibration signal, just never a penalty — see
// computeFreeTimeReward in lib/config.js.
async function endFreeTimeNow() {
  const store = await getStore();
  const now = Date.now();
  if (!store.freeTimeUntil || now >= store.freeTimeUntil) {
    return { ok: false, error: 'no active free-time window' };
  }
  const current = store.freeTimeWindows[store.freeTimeWindows.length - 1];
  const toSave = { freeTimeUntil: 0, freeTimeWindows: store.freeTimeWindows };
  if (current && !current.trained) {
    current.endedAt = now;
    current.endedEarly = true;
    current.trained = true;
    if (typeof current.armIndex === 'number' && current.context) {
      const plannedMs = minutesToMs(current.plannedMinutes);
      const elapsedFrac = plannedMs > 0 ? (now - current.startedAt) / plannedMs : 0;
      const reward = computeFreeTimeReward('ended_early', { elapsedFrac }, store.settings);
      const bandit = getFreeTimeBandit(store);
      bandit.update(current.armIndex, current.context, reward);
      toSave.freeTimeBanditState = bandit.toJSON();
    }
    await chrome.alarms.clear(`freeTimeFollowup:${current.startedAt}`);
  }
  await chrome.alarms.clear(FREE_TIME_EXPIRE_ALARM);
  await setStore(toSave);
  await rebuildBlockRules(); // restores normal gating immediately
  return { ok: true };
}

// Fires freeTimeTooShortWindowMin after a free-time window ended naturally
// (ending early trains and clears this alarm itself). Whether the window
// was long enough is judged from what's actually observable: did gating
// push back again (a denial, or an override — either means friction
// returned) or did another free-time window start, before the check
// window closed? If so, this one wasn't long enough — scored by how soon
// that happened. If the window closed with no such friction, it's a clean
// completion.
async function onFreeTimeFollowup(startedAtRaw) {
  const startedAt = Number(startedAtRaw);
  const store = await getStore();
  const entry = store.freeTimeWindows.find((w) => w.startedAt === startedAt && !w.trained);
  if (!entry || typeof entry.armIndex !== 'number' || !entry.context) return;

  const windowMs = minutesToMs(store.settings.freeTimeTooShortWindowMin);
  const windowEnd = entry.endsAt + windowMs;
  const frictionAtCandidates = [
    ...store.sessions
      .filter((s) => (s.decision === 'deny' || s.overridden) && s.grantedAt > entry.endsAt && s.grantedAt <= windowEnd)
      .map((s) => s.grantedAt),
    ...store.freeTimeWindows.filter((w) => w !== entry && w.startedAt > entry.endsAt && w.startedAt <= windowEnd).map((w) => w.startedAt),
  ];

  let reward;
  if (frictionAtCandidates.length > 0) {
    const frictionAt = Math.min(...frictionAtCandidates);
    const shortfallFrac = 1 - (frictionAt - entry.endsAt) / windowMs;
    reward = computeFreeTimeReward('too_short', { shortfallFrac }, store.settings);
  } else {
    reward = computeFreeTimeReward('completed', {}, store.settings);
  }

  const bandit = getFreeTimeBandit(store);
  bandit.update(entry.armIndex, entry.context, reward);
  entry.trained = true;

  await setStore({ freeTimeWindows: store.freeTimeWindows, freeTimeBanditState: bandit.toJSON() });
}

// ---- core decision logic -------------------------------------------------

async function handleRequestAccess(hostname, targetUrl, { skipCooldown = false } = {}) {
  let store = await getStore();
  const now = Date.now();

  // Free time already suspends every site's block rule at the DNR level
  // (rebuildBlockRules), so blocked.html shouldn't even load during a
  // window — this is a defensive fallback for a race right at the edges
  // of a window, not the primary mechanism. Unconditionally granted, no
  // bandit/cooldown state touched: a stray request during free time isn't
  // a real decision to train on.
  if (store.freeTimeUntil && now < store.freeTimeUntil) {
    const durationMin = Math.max(1, Math.round((store.freeTimeUntil - now) / 60000));
    return { granted: true, durationMin, targetUrl, freeTime: true };
  }

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
          if (store.freeTimeUntil && now < store.freeTimeUntil) {
            // Deliberately doesn't touch grace or consume anything — free
            // time overrides every other gating mechanism uniformly rather
            // than needing special-cased exceptions per credit type, and
            // per-navigation re-gating simply doesn't apply during a window.
            sendResponse({ granted: true, grace: false, freeTime: true });
            break;
          }
          // A grant that's still sitting in storage isn't necessarily still
          // valid — its expire alarm may not have fired yet (delayed, or
          // missed entirely while the extension was disabled). Unlike a
          // fresh handleRequestAccess call, this runs on every page load and
          // every detected navigation, so it's the one place that would
          // otherwise silently keep treating a long-dead grant as live
          // indefinitely - checking staleness here, not just existence,
          // closes that gap directly instead of relying on some other event
          // to eventually notice.
          //
          // isSameSubUrl matters here for a different reason than staleness:
          // the DNR block rule and registered content scripts are hostname-
          // wide (they have to be — that's the only granularity DNR/matches
          // patterns support), so without this check, ANY page on a
          // hostname would read as granted for as long as a grant exists
          // *anywhere* on that site — a fresh tab to a different video
          // while one grant is active would sail through untouched. A
          // grant only ever covers the one page it was actually made for.
          const grant = store.grants[msg.hostname];
          const notStale = !!grant && !isGrantStale(grant, now, STALE_GRANT_THRESHOLD_MIN);
          let hasGrant = notStale && isSameSubUrl(msg.url, grant.targetUrl);

          // A grant is requested from wherever you happened to be blocked —
          // often a general entry point (a homepage, a listing page), not
          // the specific content you actually meant to reach. Without this,
          // the very first click into real content right after being
          // granted would immediately fail the check above and re-gate —
          // exactly the interruption this mechanism exists to avoid. The
          // first real navigation after a fresh grant spends its one free
          // hop (see makeGrant in lib/background-helpers.js) instead, and
          // that's also where targetUrl updates to wherever this landed —
          // from then on, THAT'S the one sub-URL this grant covers. Only
          // the consuming (real-navigation) path can spend it; the non-
          // consuming initial-load peek never does, so a fresh tab/page
          // load to a different sub-URL still requires its own decision.
          if (notStale && !hasGrant && msg.consume && !grant.hopUsed) {
            hasGrant = true;
            grant.targetUrl = msg.url;
            grant.hopUsed = true;
            await setStore({ grants: store.grants });
          }
          let inGrace;
          if (hasGrant) {
            // The grant alone already covers this navigation (same sub-URL) —
            // don't also touch banked grace. Checking/consuming it here would
            // shrink a credit for a navigation that never needed it, since
            // grace and a plain same-page grant are two independent ways to
            // pass, not something that stacks.
            inGrace = false;
          } else if (msg.consume) {
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
        case 'RESET_FREE_TIME_BANDIT': {
          await setStore({ freeTimeBanditState: null });
          sendResponse({ ok: true });
          break;
        }
        case 'CLEAR_SESSIONS': {
          await setStore({ sessions: [] });
          sendResponse({ ok: true });
          break;
        }
        case 'START_FREE_TIME': {
          const result = await startFreeTime(msg.armIndex);
          sendResponse(result);
          break;
        }
        case 'END_FREE_TIME': {
          const result = await endFreeTimeNow();
          sendResponse(result);
          break;
        }
        case 'GET_FREE_TIME_SUGGESTION': {
          const store = await getStore();
          const now = Date.now();
          const eligible = eligibleFreeTimeArmIndices(store.settings);
          const { context } = freeTimeContext(store, now);
          const bandit = getFreeTimeBandit(store);
          const scored = eligible
            .map((armIndex) => ({ armIndex, durationMin: FREE_TIME_DURATIONS_MIN[armIndex], ...bandit.arms[armIndex].score(context, store.settings.freeTimeAlpha) }))
            .sort((a, b) => b.ucb - a.ucb);
          const best = scored[0] || null;

          // The two neighboring eligible arms by duration, not by score —
          // this is what lets the popup offer "shorter"/"longer" chips
          // instead of a raw number field, per the suggested pick.
          let alternatives = [];
          if (best) {
            const byDuration = eligible.slice().sort((a, b) => FREE_TIME_DURATIONS_MIN[a] - FREE_TIME_DURATIONS_MIN[b]);
            const pos = byDuration.indexOf(best.armIndex);
            alternatives = [byDuration[pos - 1], byDuration[pos + 1]]
              .filter((i) => i !== undefined)
              .map((armIndex) => ({ armIndex, durationMin: FREE_TIME_DURATIONS_MIN[armIndex] }));
          }

          const active = !!(store.freeTimeUntil && now < store.freeTimeUntil);
          const cooldownElapsed = now - store.lastFreeTimeSuggestedAt >= minutesToMs(store.settings.freeTimeSuggestCooldownMin);
          const frictionToday = globalFrictionCount24h(store.sessions, now);
          const shouldSuggest = !active && !!best && frictionToday >= store.settings.freeTimeFrictionThreshold && cooldownElapsed;
          if (shouldSuggest) await setStore({ lastFreeTimeSuggestedAt: now });

          sendResponse({
            suggestedArmIndex: best ? best.armIndex : null,
            suggestedMinutes: best ? best.durationMin : null,
            alternatives,
            shouldSuggest,
            frictionToday,
            frictionThreshold: store.settings.freeTimeFrictionThreshold,
          });
          break;
        }
        case 'GET_FREE_TIME_STATUS': {
          const store = await getStore();
          const now = Date.now();
          sendResponse({
            active: !!(store.freeTimeUntil && now < store.freeTimeUntil),
            freeTimeUntil: store.freeTimeUntil,
            maxMinutes: store.settings.freeTimeMaxMin,
          });
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
        case 'GET_FREE_TIME_BANDIT_DEBUG': {
          const store = await getStore();
          const now = Date.now();
          const { context, fatigue } = freeTimeContext(store, now);
          const bandit = getFreeTimeBandit(store);
          const eligible = eligibleFreeTimeArmIndices(store.settings);
          const scores = bandit.arms.map((a, i) => ({
            durationMin: FREE_TIME_DURATIONS_MIN[i],
            eligible: eligible.includes(i),
            ...a.score(context, store.settings.freeTimeAlpha),
          }));
          sendResponse({ context, scores, effortMinutesToday: fatigue.totalActiveMinLast24h, frictionToday: globalFrictionCount24h(store.sessions, now) });
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
  await reconcileOpenTabs();
});

// Re-enabling a disabled extension (or a browser restart) doesn't fire
// onInstalled — but it does re-run this module's top-level code, since
// that's exactly what "starting the service worker back up" means. That
// makes this the earliest possible hook for noticing a gap, rather than
// waiting for the next scheduled heartbeat alarm to happen to fire (which
// could lag the actual re-enable by up to HEARTBEAT_PERIOD_MIN), and for
// reconciling open tabs against reality (see reconcileOpenTabs) rather
// than leaving tabs that were already open unenforced until they happen
// to navigate on their own. Wrapped so a missing permission or a
// cold-start race with storage doesn't crash the service worker on every
// wake.
(async () => {
  try {
    await onHeartbeat();
    await ensureHeartbeatAlarm();
    await reconcileOpenTabs();
  } catch (err) {
    console.error('[background] startup reconciliation failed:', err);
  }
})();
