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

// Blocks every managed site at once, initiated by the user rather than the
// bandit — see DEFAULT_BREAK_MAX_MIN's comment in lib/config.js. Overriding
// it early is deliberately only available from a site's blocked page (same
// wait-then-hold friction as any other override), not from this popup, so
// backing out takes the same real effort as it does everywhere else.
//
// The duration itself is never typed in — GET_BREAK_SUGGESTION returns the
// break-duration bandit's current pick plus its two nearest eligible
// neighbors, and starting one is a single click on a duration chip. The
// section stays hidden by default; it surfaces on its own once today's
// cross-site usage crosses breakEffortThresholdMin (see
// docs/adr/0003-break-duration-bandit-and-fatigue-feature.md), or can be
// opened on demand via the small "Take a break" link either way.
const activeEl = document.getElementById('breakActive');
const suggestionEl = document.getElementById('breakSuggestion');
const promptEl = document.getElementById('breakPrompt');
const chipsEl = document.getElementById('breakChips');
const breakLink = document.getElementById('breakLink');

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
      await chrome.runtime.sendMessage({ type: 'START_BREAK', armIndex: opt.armIndex });
      render();
      renderBreak();
    });
    chipsEl.appendChild(chip);
  }
  suggestionEl.style.display = 'block';
  breakLink.style.display = 'none';
}

async function renderBreak() {
  const status = await chrome.runtime.sendMessage({ type: 'GET_BREAK_STATUS' });

  if (status.active) {
    activeEl.style.display = 'block';
    suggestionEl.style.display = 'none';
    breakLink.style.display = 'none';
    const remainingMin = Math.max(1, Math.ceil((status.breakUntil - Date.now()) / 60000));
    activeEl.textContent = `On a break — ${remainingMin} minute${remainingMin === 1 ? '' : 's'} remaining. Ending it early is only available from a site's blocked page.`;
    return;
  }
  activeEl.style.display = 'none';
  suggestionEl.style.display = 'none';

  const suggestion = await chrome.runtime.sendMessage({ type: 'GET_BREAK_SUGGESTION' });
  if (suggestion.suggestedArmIndex === null) {
    breakLink.style.display = 'none'; // no break duration fits the configured cap
    return;
  }

  if (suggestion.shouldSuggest) {
    const usedMin = Math.round(suggestion.effortMinutesToday);
    renderChips(suggestion, `You've spent about ${usedMin} min on managed sites today — take a break?`);
  } else {
    breakLink.style.display = 'inline-block';
    breakLink.onclick = () => renderChips(suggestion, 'Suggested break, based on what has held up before:');
  }
}

render();
renderBreak();
