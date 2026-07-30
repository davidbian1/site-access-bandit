const params = new URLSearchParams(location.search);
const hostname = params.get('site') || '';
const targetUrl = params.get('target') || `https://${hostname}/`;

document.getElementById('site').textContent = hostname;

const btn = document.getElementById('requestBtn');
const overrideBtn = document.getElementById('overrideBtn');
const overrideLabel = overrideBtn.querySelector('.label');
const overrideFill = overrideBtn.querySelector('.hold-fill');
const status = document.getElementById('status');

let countdownTimer = null;
let overrideDelayTimer = null;
let holdTimer = null;
let holding = false;
let holdMs = 3000;
let overriding = false;

function goToTarget() {
  setTimeout(() => {
    location.href = targetUrl;
  }, 600);
}

function startCooldownCountdown(retryAtMs) {
  clearInterval(countdownTimer);
  btn.disabled = true;
  countdownTimer = setInterval(() => {
    const remaining = Math.max(0, retryAtMs - Date.now());
    if (remaining <= 0) {
      clearInterval(countdownTimer);
      btn.disabled = false;
      status.textContent = '';
      return;
    }
    status.textContent = `You just asked — try again in ${Math.ceil(remaining / 1000)}s`;
  }, 250);
}

// The override button doesn't just work on a tap: it stays disabled behind a
// wait (longer the more you've already leaned on it for this site), then
// needs a sustained press-and-hold rather than a click, so reaching for it
// takes deliberate, sustained effort rather than reflex.
function armOverrideButton(delaySec, holdMsFromServer) {
  holdMs = holdMsFromServer || 3000;
  overrideBtn.style.display = 'inline-block';
  overrideBtn.disabled = true;
  clearInterval(overrideDelayTimer);

  let remaining = Math.ceil(delaySec || 0);
  const tick = () => {
    if (remaining <= 0) {
      clearInterval(overrideDelayTimer);
      overrideBtn.disabled = false;
      overrideLabel.textContent = `Hold to override (${Math.round(holdMs / 1000)}s)`;
      return;
    }
    overrideLabel.textContent = `I really need this (available in ${remaining}s)`;
    remaining -= 1;
  };
  tick();
  overrideDelayTimer = setInterval(tick, 1000);
}

function cancelHold() {
  if (!holding) return;
  holding = false;
  clearTimeout(holdTimer);
  overrideBtn.classList.remove('holding');
}

async function completeOverride() {
  if (overriding) return;
  overriding = true;
  btn.disabled = true;
  overrideBtn.disabled = true;
  clearInterval(overrideDelayTimer);
  status.textContent = 'Overriding…';
  const response = await chrome.runtime.sendMessage({
    type: 'OVERRIDE_DENY',
    hostname,
    targetUrl,
  });

  if (response.granted) {
    status.textContent = `Granted for ${response.durationMin} minute${response.durationMin === 1 ? '' : 's'} — redirecting…`;
    overrideBtn.style.display = 'none';
    goToTarget();
    return;
  }

  overriding = false;
  status.textContent = "Couldn't override — try Request access again.";
  btn.disabled = false;
  overrideBtn.disabled = false;
}

function startHold() {
  if (overrideBtn.disabled || overriding) return;
  holding = true;
  overrideBtn.classList.add('holding');
  overrideFill.style.transitionDuration = `${holdMs}ms`;
  holdTimer = setTimeout(() => {
    if (holding) completeOverride();
  }, holdMs);
}

overrideBtn.addEventListener('mousedown', startHold);
overrideBtn.addEventListener('mouseup', cancelHold);
overrideBtn.addEventListener('mouseleave', cancelHold);
overrideBtn.addEventListener('touchstart', (e) => {
  e.preventDefault();
  startHold();
});
overrideBtn.addEventListener('touchend', cancelHold);
overrideBtn.addEventListener('touchcancel', cancelHold);

btn.addEventListener('click', async () => {
  btn.disabled = true;
  overrideBtn.style.display = 'none';
  clearInterval(overrideDelayTimer);
  status.textContent = 'Thinking…';
  const response = await chrome.runtime.sendMessage({
    type: 'REQUEST_ACCESS',
    hostname,
    targetUrl,
  });

  if (response.granted) {
    status.textContent = `Granted for ${response.durationMin} minute${response.durationMin === 1 ? '' : 's'} — redirecting…`;
    goToTarget();
    return;
  }

  if (response.cooldown) {
    startCooldownCountdown(response.retryAtMs);
    return;
  }

  status.textContent = 'Not granted this time.';
  btn.disabled = false;
  armOverrideButton(response.overrideDelaySec, response.overrideHoldMs);
});
