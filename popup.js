import { hostnameFromUrl } from './lib/config.js';

function fmtRemaining(ms) {
  const totalSec = Math.max(0, Math.round(ms / 1000));
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return `${m}:${s.toString().padStart(2, '0')}`;
}

async function requestHostPermission(hostname) {
  return chrome.permissions.request({ origins: [`*://*.${hostname}/*`, `*://${hostname}/*`] });
}

async function render() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const hostname = tab ? hostnameFromUrl(tab.url || '') : null;
  const currentSiteEl = document.getElementById('currentSite');
  const sitesEl = document.getElementById('sites');

  if (!hostname) {
    currentSiteEl.textContent = 'No active tab site detected.';
  } else {
    const status = await chrome.runtime.sendMessage({ type: 'GET_STATUS', hostname });
    currentSiteEl.innerHTML = '';
    const title = document.createElement('div');
    title.style.fontWeight = '600';
    title.textContent = hostname;
    currentSiteEl.appendChild(title);

    if (status.grant) {
      const info = document.createElement('div');
      info.className = 'muted';
      info.textContent = `Granted — ${fmtRemaining(status.grant.remainingMs)} remaining`;
      currentSiteEl.appendChild(info);
      const endBtn = document.createElement('button');
      endBtn.className = 'danger';
      endBtn.textContent = 'End session now';
      endBtn.style.marginTop = '8px';
      endBtn.addEventListener('click', async () => {
        await chrome.runtime.sendMessage({ type: 'END_SESSION', hostname });
        render();
      });
      currentSiteEl.appendChild(endBtn);
    } else if (status.isManaged) {
      const info = document.createElement('div');
      info.className = 'muted';
      info.textContent = 'Managed — access is decided by the bandit when you visit.';
      currentSiteEl.appendChild(info);
    } else {
      const addBtn = document.createElement('button');
      addBtn.className = 'primary';
      addBtn.textContent = 'Manage this site';
      addBtn.style.marginTop = '8px';
      addBtn.addEventListener('click', async () => {
        const granted = await requestHostPermission(hostname);
        if (!granted) return;
        await chrome.runtime.sendMessage({ type: 'ADD_SITE', hostname });
        render();
      });
      currentSiteEl.appendChild(addBtn);
    }

    sitesEl.innerHTML = '';
    for (const site of status.sites) {
      const row = document.createElement('div');
      row.className = 'row';
      const label = document.createElement('span');
      label.textContent = site.hostname;
      const removeBtn = document.createElement('button');
      removeBtn.className = 'danger';
      removeBtn.textContent = 'Remove';
      removeBtn.addEventListener('click', async () => {
        await chrome.runtime.sendMessage({ type: 'REMOVE_SITE', hostname: site.hostname });
        render();
      });
      row.appendChild(label);
      row.appendChild(removeBtn);
      sitesEl.appendChild(row);
    }
    if (status.sites.length === 0) {
      sitesEl.innerHTML = '<div class="muted">No sites managed yet.</div>';
    }
  }
}

// Suspends gating across every managed site at once, initiated by the
// user rather than the bandit — see DEFAULT_FREE_TIME_MAX_MIN's comment
// in lib/config.js (and docs/adr/0003's Update section for why this
// replaced an earlier design that blocked instead of granted). Ending it
// early is deliberately frictionless — right here, one click, no wait or
// hold — since choosing to re-enable your own gating early is a
// disciplined act, not something that needs to cost effort.
//
// The duration itself is never typed in — GET_FREE_TIME_SUGGESTION
// returns the free-time-duration bandit's current pick plus its two
// nearest eligible neighbors, and starting one is a single click on a
// duration chip. The section stays hidden by default; it surfaces on its
// own once today's friction (denials/overrides across all sites) crosses
// freeTimeFrictionThreshold, or can be opened on demand via the small
// "Free time" link either way.
const activeEl = document.getElementById('freeTimeActive');
const activeTextEl = document.getElementById('freeTimeActiveText');
const endFreeTimeBtn = document.getElementById('endFreeTimeBtn');
const suggestionEl = document.getElementById('freeTimeSuggestion');
const promptEl = document.getElementById('freeTimePrompt');
const chipsEl = document.getElementById('freeTimeChips');
const freeTimeLink = document.getElementById('freeTimeLink');

function renderChips(suggestion, promptText) {
  promptEl.textContent = promptText;
  chipsEl.innerHTML = '';
  const options = [suggestion.suggestedArmIndex, ...suggestion.alternatives.map((a) => a.armIndex)]
    .map((armIndex) => {
      if (armIndex === suggestion.suggestedArmIndex) return { armIndex, durationMin: suggestion.suggestedMinutes, suggested: true };
      return suggestion.alternatives.find((a) => a.armIndex === armIndex);
    })
    .sort((a, b) => a.durationMin - b.durationMin);

  for (const opt of options) {
    const chip = document.createElement('button');
    chip.className = opt.suggested ? 'chip suggested' : 'chip';
    chip.textContent = `${opt.durationMin} min`;
    chip.addEventListener('click', async () => {
      await chrome.runtime.sendMessage({ type: 'START_FREE_TIME', armIndex: opt.armIndex });
      render();
      renderFreeTime();
    });
    chipsEl.appendChild(chip);
  }
  suggestionEl.style.display = 'block';
  freeTimeLink.style.display = 'none';
}

async function renderFreeTime() {
  const status = await chrome.runtime.sendMessage({ type: 'GET_FREE_TIME_STATUS' });

  if (status.active) {
    activeEl.style.display = 'block';
    suggestionEl.style.display = 'none';
    freeTimeLink.style.display = 'none';
    const remainingMin = Math.max(1, Math.ceil((status.freeTimeUntil - Date.now()) / 60000));
    activeTextEl.textContent = `Free time — ${remainingMin} minute${remainingMin === 1 ? '' : 's'} remaining. All managed sites are open.`;
    return;
  }
  activeEl.style.display = 'none';
  suggestionEl.style.display = 'none';

  const suggestion = await chrome.runtime.sendMessage({ type: 'GET_FREE_TIME_SUGGESTION' });
  if (suggestion.suggestedArmIndex === null) {
    freeTimeLink.style.display = 'none'; // no duration fits the configured cap
    return;
  }

  if (suggestion.shouldSuggest) {
    renderChips(suggestion, `The gate's pushed back a few times today — want some free time?`);
  } else {
    freeTimeLink.style.display = 'inline-block';
    freeTimeLink.onclick = () => renderChips(suggestion, 'Suggested free time, based on what has held up before:');
  }
}

endFreeTimeBtn.addEventListener('click', async () => {
  await chrome.runtime.sendMessage({ type: 'END_FREE_TIME' });
  render();
  renderFreeTime();
});

render();
renderFreeTime();
