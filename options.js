import { normalizeHostname } from './lib/config.js';

async function requestHostPermission(hostname) {
  return chrome.permissions.request({ origins: [`*://*.${hostname}/*`, `*://${hostname}/*`] });
}

async function loadSites() {
  const status = await chrome.runtime.sendMessage({ type: 'GET_STATUS', hostname: '__none__' });
  const tbody = document.querySelector('#sitesTable tbody');
  tbody.innerHTML = '';
  for (const site of status.sites) {
    const tr = document.createElement('tr');
    const hostnameTd = document.createElement('td');
    hostnameTd.textContent = site.hostname;
    const addedTd = document.createElement('td');
    addedTd.textContent = new Date(site.addedAt).toLocaleDateString();
    const actionTd = document.createElement('td');
    const spacerTd = document.createElement('td');

    const removeBtn = document.createElement('button');
    removeBtn.className = 'danger';
    removeBtn.textContent = 'Remove';
    removeBtn.addEventListener('click', async () => {
      await chrome.runtime.sendMessage({ type: 'REMOVE_SITE', hostname: site.hostname });
      loadSites();
    });
    actionTd.appendChild(removeBtn);

    tr.append(hostnameTd, addedTd, actionTd, spacerTd);
    tbody.appendChild(tr);
  }
}

document.getElementById('addSiteBtn').addEventListener('click', async () => {
  const raw = document.getElementById('newSite').value.trim();
  const hostname = normalizeHostname(raw);
  if (!hostname) return;
  const granted = await requestHostPermission(hostname);
  if (!granted) return;
  await chrome.runtime.sendMessage({ type: 'ADD_SITE', hostname });
  document.getElementById('newSite').value = '';
  loadSites();
});

async function loadSettings() {
  const { settings } = await chrome.runtime.sendMessage({ type: 'GET_SETTINGS' });
  document.getElementById('alpha').value = settings.alpha;
  document.getElementById('discountFactor').value = settings.discountFactor;
  document.getElementById('crossSiteWarmStartWeight').value = settings.crossSiteWarmStartWeight;
  document.getElementById('armDurations').value = settings.armDurationsMin.join(',');
  document.getElementById('penaltyPerMinute').value = settings.penaltyPerMinute;
  document.getElementById('denyReward').value = settings.denyReward;
  document.getElementById('overrideSessionPenalty').value = settings.overrideSessionPenalty;
  document.getElementById('frequencyWindowMin').value = settings.frequencyWindowMin;
  document.getElementById('frequencyPenaltyPerSession').value = settings.frequencyPenaltyPerSession;
  document.getElementById('maxFrequencyPenalty').value = settings.maxFrequencyPenalty;
  document.getElementById('denyOverridePenalty').value = settings.denyOverridePenalty;
  document.getElementById('overrideWindowMin').value = settings.overrideWindowMin;
  document.getElementById('overrideBaseDelaySec').value = settings.overrideBaseDelaySec;
  document.getElementById('overrideDelayRampSec').value = settings.overrideDelayRampSec;
  document.getElementById('overrideMaxDelaySec').value = settings.overrideMaxDelaySec;
  document.getElementById('overrideHoldMs').value = settings.overrideHoldMs;
  document.getElementById('overrideEffortDiscountSec').value = settings.overrideEffortDiscountSec;
  document.getElementById('overrideGraceMin').value = settings.overrideGraceMin;
  document.getElementById('overrideGraceHopCount').value = settings.overrideGraceHopCount;
  document.getElementById('trustHalfLifeMin').value = settings.trustHalfLifeMin;
  document.getElementById('trustOverrideBoost').value = settings.trustOverrideBoost;
  document.getElementById('trustMaxDiscount').value = settings.trustMaxDiscount;
  document.getElementById('longFormDwellMin').value = settings.longFormDwellMin;
  document.getElementById('extremeLongFormMin').value = settings.extremeLongFormMin;
  document.getElementById('extendOfferWindowMin').value = settings.extendOfferWindowMin;
  document.getElementById('extendGraceMin').value = settings.extendGraceMin;
  document.getElementById('extendHopCount').value = settings.extendHopCount;
  document.getElementById('extendGrantMin').value = settings.extendGrantMin;
  document.getElementById('minCooldownSec').value = settings.minCooldownSec;
  document.getElementById('maxCooldownSec').value = settings.maxCooldownSec;
  document.getElementById('cooldownRampSecPerMin').value = settings.cooldownRampSecPerMin;
  document.getElementById('freeTimeMaxMin').value = settings.freeTimeMaxMin;
  document.getElementById('freeTimeAlpha').value = settings.freeTimeAlpha;
  document.getElementById('freeTimeDiscountFactor').value = settings.freeTimeDiscountFactor;
  document.getElementById('freeTimeCompleteBonus').value = settings.freeTimeCompleteBonus;
  document.getElementById('freeTimeTooShortPenalty').value = settings.freeTimeTooShortPenalty;
  document.getElementById('freeTimeTooShortWindowMin').value = settings.freeTimeTooShortWindowMin;
  document.getElementById('freeTimeFrictionThreshold').value = settings.freeTimeFrictionThreshold;
  document.getElementById('freeTimeSuggestCooldownMin').value = settings.freeTimeSuggestCooldownMin;
}

document.getElementById('saveSettingsBtn').addEventListener('click', async () => {
  const armDurationsMin = document
    .getElementById('armDurations')
    .value.split(',')
    .map((s) => parseFloat(s.trim()))
    .filter((n) => !Number.isNaN(n));

  const settings = {
    alpha: parseFloat(document.getElementById('alpha').value),
    discountFactor: parseFloat(document.getElementById('discountFactor').value),
    crossSiteWarmStartWeight: parseFloat(document.getElementById('crossSiteWarmStartWeight').value),
    armDurationsMin,
    penaltyPerMinute: parseFloat(document.getElementById('penaltyPerMinute').value),
    denyReward: parseFloat(document.getElementById('denyReward').value),
    overrideSessionPenalty: parseFloat(document.getElementById('overrideSessionPenalty').value),
    frequencyWindowMin: parseFloat(document.getElementById('frequencyWindowMin').value),
    frequencyPenaltyPerSession: parseFloat(document.getElementById('frequencyPenaltyPerSession').value),
    maxFrequencyPenalty: parseFloat(document.getElementById('maxFrequencyPenalty').value),
    denyOverridePenalty: parseFloat(document.getElementById('denyOverridePenalty').value),
    overrideWindowMin: parseFloat(document.getElementById('overrideWindowMin').value),
    overrideBaseDelaySec: parseFloat(document.getElementById('overrideBaseDelaySec').value),
    overrideDelayRampSec: parseFloat(document.getElementById('overrideDelayRampSec').value),
    overrideMaxDelaySec: parseFloat(document.getElementById('overrideMaxDelaySec').value),
    overrideHoldMs: parseFloat(document.getElementById('overrideHoldMs').value),
    overrideEffortDiscountSec: parseFloat(document.getElementById('overrideEffortDiscountSec').value),
    overrideGraceMin: parseFloat(document.getElementById('overrideGraceMin').value),
    overrideGraceHopCount: parseFloat(document.getElementById('overrideGraceHopCount').value),
    trustHalfLifeMin: parseFloat(document.getElementById('trustHalfLifeMin').value),
    trustOverrideBoost: parseFloat(document.getElementById('trustOverrideBoost').value),
    trustMaxDiscount: parseFloat(document.getElementById('trustMaxDiscount').value),
    longFormDwellMin: parseFloat(document.getElementById('longFormDwellMin').value),
    extremeLongFormMin: parseFloat(document.getElementById('extremeLongFormMin').value),
    extendOfferWindowMin: parseFloat(document.getElementById('extendOfferWindowMin').value),
    extendGraceMin: parseFloat(document.getElementById('extendGraceMin').value),
    extendHopCount: parseFloat(document.getElementById('extendHopCount').value),
    extendGrantMin: parseFloat(document.getElementById('extendGrantMin').value),
    minCooldownSec: parseFloat(document.getElementById('minCooldownSec').value),
    maxCooldownSec: parseFloat(document.getElementById('maxCooldownSec').value),
    cooldownRampSecPerMin: parseFloat(document.getElementById('cooldownRampSecPerMin').value),
    freeTimeMaxMin: parseFloat(document.getElementById('freeTimeMaxMin').value),
    freeTimeAlpha: parseFloat(document.getElementById('freeTimeAlpha').value),
    freeTimeDiscountFactor: parseFloat(document.getElementById('freeTimeDiscountFactor').value),
    freeTimeCompleteBonus: parseFloat(document.getElementById('freeTimeCompleteBonus').value),
    freeTimeTooShortPenalty: parseFloat(document.getElementById('freeTimeTooShortPenalty').value),
    freeTimeTooShortWindowMin: parseFloat(document.getElementById('freeTimeTooShortWindowMin').value),
    freeTimeFrictionThreshold: parseFloat(document.getElementById('freeTimeFrictionThreshold').value),
    freeTimeSuggestCooldownMin: parseFloat(document.getElementById('freeTimeSuggestCooldownMin').value),
  };
  await chrome.runtime.sendMessage({ type: 'SET_SETTINGS', settings });
  const status = document.getElementById('saveStatus');
  status.textContent = 'Saved.';
  setTimeout(() => (status.textContent = ''), 1500);
});

document.getElementById('debugBtn').addEventListener('click', async () => {
  const hostname = normalizeHostname(document.getElementById('debugSite').value.trim());
  if (!hostname) return;
  const { scores, trust } = await chrome.runtime.sendMessage({ type: 'GET_BANDIT_DEBUG', hostname });
  document.getElementById('trustDisplay').textContent = `Current trust credit: ${(trust * 100).toFixed(0)}% (decays over time; boosted by overrides)`;
  const tbody = document.querySelector('#debugTable tbody');
  tbody.innerHTML = '';
  for (const s of scores) {
    const tr = document.createElement('tr');
    for (const text of [s.durationMin, s.mean.toFixed(3), s.variance.toFixed(3), s.ucb.toFixed(3)]) {
      const td = document.createElement('td');
      td.textContent = text;
      tr.appendChild(td);
    }
    tbody.appendChild(tr);
  }
});

document.getElementById('resetOneBtn').addEventListener('click', async () => {
  const hostname = normalizeHostname(document.getElementById('debugSite').value.trim());
  if (!hostname) return;
  await chrome.runtime.sendMessage({ type: 'RESET_BANDIT', hostname });
});

document.getElementById('resetAllBtn').addEventListener('click', async () => {
  await chrome.runtime.sendMessage({ type: 'RESET_BANDIT' });
});

document.getElementById('freeTimeDebugBtn').addEventListener('click', async () => {
  const { scores, effortMinutesToday, frictionToday } = await chrome.runtime.sendMessage({ type: 'GET_FREE_TIME_BANDIT_DEBUG' });
  document.getElementById('freeTimeEffortDisplay').textContent =
    `Cross-site active time in the last 24h: ${effortMinutesToday.toFixed(1)} min — friction (denials/overrides) today: ${frictionToday}`;
  const tbody = document.querySelector('#freeTimeDebugTable tbody');
  tbody.innerHTML = '';
  for (const s of scores) {
    const tr = document.createElement('tr');
    for (const text of [s.durationMin, s.eligible ? 'yes' : 'no (over cap)', s.mean.toFixed(3), s.variance.toFixed(3), s.ucb.toFixed(3)]) {
      const td = document.createElement('td');
      td.textContent = text;
      tr.appendChild(td);
    }
    tbody.appendChild(tr);
  }
});

document.getElementById('freeTimeResetBtn').addEventListener('click', async () => {
  await chrome.runtime.sendMessage({ type: 'RESET_FREE_TIME_BANDIT' });
});

// The concrete unlock for ADR 0001/0003's "validate against real usage
// data" next step: eval/tune.py and a future free-time-bandit equivalent
// both need real logged sessions, not synthetic ones, and this is the only way
// to get them out of chrome.storage.local. No "downloads" permission
// needed — a plain same-page anchor click triggers a normal browser
// download, same as any regular web page offering a file save.
document.getElementById('exportSessionsBtn').addEventListener('click', async () => {
  const { sessions } = await chrome.runtime.sendMessage({ type: 'GET_SESSIONS' });
  const blob = new Blob([JSON.stringify(sessions, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `mindful-access-sessions-${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  URL.revokeObjectURL(url);
});

document.getElementById('clearSessionsBtn').addEventListener('click', async () => {
  await chrome.runtime.sendMessage({ type: 'CLEAR_SESSIONS' });
  loadSessions();
  loadTrends();
});

async function loadSessions() {
  const { sessions } = await chrome.runtime.sendMessage({ type: 'GET_SESSIONS' });
  const tbody = document.querySelector('#sessionsTable tbody');
  tbody.innerHTML = '';
  for (const s of sessions.slice(0, 200)) {
    const tr = document.createElement('tr');
    const endReasonParts = [s.endReason];
    if (s.overridden) endReasonParts.push('overridden');
    if (s.stale) endReasonParts.push('stale — not trained');
    const endReason = endReasonParts.join(' / ');
    const cells = [
      s.hostname,
      new Date(s.grantedAt).toLocaleString(),
      s.decision,
      s.durationMin,
      s.activeMinutes.toFixed(1),
      s.reward.toFixed(3),
      endReason,
    ];
    for (const text of cells) {
      const td = document.createElement('td');
      td.textContent = text;
      tr.appendChild(td);
    }
    tbody.appendChild(tr);
  }
}

// Groups session history per site and splits each site's reward-bearing
// decisions (grant/deny; excludes reconstructed-gap entries, which carry no
// reward) into an early half and a recent half chronologically, so a swing
// in the average is visible without needing a chart library. Deliberately
// not just "total time on site": that number is confounded by how much you
// happened to want the site that week, not just how the bandit is scoring
// arms — see options.html's caveat text above the table.
function computeTrends(sessions) {
  const byHost = new Map();
  for (const s of sessions) {
    if (!byHost.has(s.hostname)) byHost.set(s.hostname, { real: [], reconstructedMin: 0 });
    const bucket = byHost.get(s.hostname);
    if (s.reconstructed) {
      bucket.reconstructedMin += s.activeMinutes || 0;
    } else if (s.decision === 'grant' || s.decision === 'deny') {
      bucket.real.push(s);
    }
  }

  const rows = [];
  for (const [hostname, { real, reconstructedMin }] of byHost) {
    const chronological = real.slice().sort((a, b) => a.grantedAt - b.grantedAt);
    const mid = Math.floor(chronological.length / 2);
    const early = chronological.slice(0, mid);
    const recent = chronological.slice(mid);

    const avg = (arr, fn) => (arr.length ? arr.reduce((sum, s) => sum + fn(s), 0) / arr.length : null);
    const rewardEarly = avg(early, (s) => s.reward || 0);
    const rewardRecent = avg(recent, (s) => s.reward || 0);
    const overrideRateEarly = avg(early, (s) => (s.overridden ? 1 : 0));
    const overrideRateRecent = avg(recent, (s) => (s.overridden ? 1 : 0));
    const realActiveMin = chronological.reduce((sum, s) => sum + (s.activeMinutes || 0), 0);

    rows.push({
      hostname,
      sessionCount: chronological.length,
      rewardEarly,
      rewardRecent,
      overrideRateEarly,
      overrideRateRecent,
      realActiveMin,
      reconstructedMin,
    });
  }
  return rows.sort((a, b) => b.sessionCount - a.sessionCount);
}

function fmtOrDash(n, digits = 3) {
  return n === null ? '—' : n.toFixed(digits);
}

async function loadTrends() {
  const { sessions } = await chrome.runtime.sendMessage({ type: 'GET_SESSIONS' });
  const rows = computeTrends(sessions);
  const tbody = document.querySelector('#trendsTable tbody');
  tbody.innerHTML = '';
  for (const r of rows) {
    const tr = document.createElement('tr');
    const cells = [
      r.hostname,
      String(r.sessionCount),
      `${fmtOrDash(r.rewardEarly)} → ${fmtOrDash(r.rewardRecent)}`,
      `${fmtOrDash(r.overrideRateEarly, 2)} → ${fmtOrDash(r.overrideRateRecent, 2)}`,
      r.realActiveMin.toFixed(1),
      r.reconstructedMin > 0 ? r.reconstructedMin.toFixed(1) : '—',
    ];
    for (const text of cells) {
      const td = document.createElement('td');
      td.textContent = text;
      tr.appendChild(td);
    }
    tbody.appendChild(tr);
  }
}

loadSites();
loadSettings();
loadSessions();
loadTrends();
