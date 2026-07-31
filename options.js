function normalizeHostname(input) {
  try {
    const withScheme = /^[a-zA-Z]+:\/\//.test(input) ? input : `https://${input}`;
    return new URL(withScheme).hostname.replace(/^www\./, '');
  } catch {
    return null;
  }
}

async function requestHostPermission(hostname) {
  return chrome.permissions.request({ origins: [`*://*.${hostname}/*`, `*://${hostname}/*`] });
}

async function loadSites() {
  const status = await chrome.runtime.sendMessage({ type: 'GET_STATUS', hostname: '__none__' });
  const tbody = document.querySelector('#sitesTable tbody');
  tbody.innerHTML = '';
  for (const site of status.sites) {
    const tr = document.createElement('tr');
    tr.innerHTML = `<td>${site.hostname}</td><td>${new Date(site.addedAt).toLocaleDateString()}</td><td></td><td></td>`;
    const removeBtn = document.createElement('button');
    removeBtn.className = 'danger';
    removeBtn.textContent = 'Remove';
    removeBtn.addEventListener('click', async () => {
      await chrome.runtime.sendMessage({ type: 'REMOVE_SITE', hostname: site.hostname });
      loadSites();
    });
    tr.children[2].appendChild(removeBtn);
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
}

document.getElementById('saveSettingsBtn').addEventListener('click', async () => {
  const armDurationsMin = document
    .getElementById('armDurations')
    .value.split(',')
    .map((s) => parseFloat(s.trim()))
    .filter((n) => !Number.isNaN(n));

  const settings = {
    alpha: parseFloat(document.getElementById('alpha').value),
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
    tr.innerHTML = `<td>${s.durationMin}</td><td>${s.mean.toFixed(3)}</td><td>${s.variance.toFixed(3)}</td><td>${s.ucb.toFixed(3)}</td>`;
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

document.getElementById('clearSessionsBtn').addEventListener('click', async () => {
  await chrome.runtime.sendMessage({ type: 'CLEAR_SESSIONS' });
  loadSessions();
});

async function loadSessions() {
  const { sessions } = await chrome.runtime.sendMessage({ type: 'GET_SESSIONS' });
  const tbody = document.querySelector('#sessionsTable tbody');
  tbody.innerHTML = '';
  for (const s of sessions.slice(0, 200)) {
    const tr = document.createElement('tr');
    const endReason = s.overridden ? `${s.endReason} (overridden)` : s.endReason;
    tr.innerHTML = `<td>${s.hostname}</td><td>${new Date(s.grantedAt).toLocaleString()}</td><td>${s.decision}</td><td>${s.durationMin}</td><td>${s.activeMinutes.toFixed(1)}</td><td>${s.reward.toFixed(3)}</td><td>${endReason}</td>`;
    tbody.appendChild(tr);
  }
}

loadSites();
loadSettings();
loadSessions();
