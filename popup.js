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

render();
