const params = new URLSearchParams(location.search);
const hostname = params.get('site') || '';
const targetUrl = params.get('target') || `https://${hostname}/`;

document.getElementById('site').textContent = hostname;

const btn = document.getElementById('requestBtn');
const status = document.getElementById('status');

let countdownTimer = null;
let overrideDelayTimer = null;

function goToTarget() {
  setTimeout(() => {
    location.href = targetUrl;
  }, 600);
}

// Shared press-and-hold interaction: a button that requires a sustained hold
// (not a click) to fire, with a visible fill animation, so it can't be
// tapped through on reflex. Used for override, extend, and skip-cooldown.
function makeHoldButton(el, { label, onFire }) {
  const fill = el.querySelector('.hold-fill');
  const labelEl = el.querySelector('.label');
  let holdMs = 3000;
  let holdTimer = null;
  let holding = false;
  let firing = false;

  function setLabel(text) {
    labelEl.textContent = text;
  }

  function cancelHold() {
    if (!holding) return;
    holding = false;
    clearTimeout(holdTimer);
    el.classList.remove('holding');
  }

  function startHold() {
    if (el.disabled || firing) return;
    holding = true;
    el.classList.add('holding');
    fill.style.transitionDuration = `${holdMs}ms`;
    holdTimer = setTimeout(() => {
      if (holding) fire();
    }, holdMs);
  }

  async function fire() {
    if (firing) return;
    firing = true;
    el.disabled = true;
    await onFire();
    firing = false;
  }

  el.addEventListener('mousedown', startHold);
  el.addEventListener('mouseup', cancelHold);
  el.addEventListener('mouseleave', cancelHold);
  el.addEventListener('touchstart', (e) => {
    e.preventDefault();
    startHold();
  });
  el.addEventListener('touchend', cancelHold);
  el.addEventListener('touchcancel', cancelHold);

  return {
    show(readyLabel, holdMsFromServer) {
      holdMs = holdMsFromServer || 3000;
      el.style.display = 'inline-block';
      el.disabled = false;
      setLabel(readyLabel || `${label} (${Math.round(holdMs / 1000)}s)`);
    },
    hide() {
      el.style.display = 'none';
    },
    disable() {
      el.disabled = true;
    },
    enable() {
      el.disabled = false;
    },
    setLabel,
  };
}

// ---- override ("I really need this" after a denial) ----

const overrideBtn = document.getElementById('overrideBtn');
const override = makeHoldButton(overrideBtn, {
  label: 'Hold to override',
  onFire: async () => {
    btn.disabled = true;
    clearInterval(overrideDelayTimer);
    status.textContent = 'Overriding…';
    const response = await chrome.runtime.sendMessage({ type: 'OVERRIDE_DENY', hostname, targetUrl });

    if (response.granted) {
      status.textContent = `Granted for ${response.durationMin} minute${response.durationMin === 1 ? '' : 's'} — redirecting…`;
      override.hide();
      goToTarget();
      return;
    }

    status.textContent = "Couldn't override — try Request access again.";
    btn.disabled = false;
    override.enable();
  },
});

// The override button doesn't just work on a tap: it stays disabled behind a
// wait (longer the more you've already leaned on it for this site), then
// needs the sustained hold above, so reaching for it takes deliberate,
// sustained effort rather than reflex.
function armOverrideButton(delaySec, holdMs) {
  overrideBtn.style.display = 'inline-block';
  overrideBtn.disabled = true;
  clearInterval(overrideDelayTimer);

  let remaining = Math.ceil(delaySec || 0);
  const tick = () => {
    if (remaining <= 0) {
      clearInterval(overrideDelayTimer);
      override.show(`Hold to override (${Math.round((holdMs || 3000) / 1000)}s)`, holdMs);
      return;
    }
    override.setLabel(`I really need this (available in ${remaining}s)`);
    remaining -= 1;
  };
  tick();
  overrideDelayTimer = setInterval(tick, 1000);
}

// ---- skip cooldown ("Ask now instead of waiting") ----

const skipCooldownBtn = document.getElementById('skipCooldownBtn');
const skipCooldown = makeHoldButton(skipCooldownBtn, {
  label: 'Hold to ask now',
  onFire: async () => {
    clearInterval(countdownTimer);
    skipCooldown.hide();
    status.textContent = 'Asking…';
    const response = await chrome.runtime.sendMessage({ type: 'OVERRIDE_COOLDOWN', hostname, targetUrl });
    handleAccessResult(response);
  },
});

function startCooldownCountdown(retryAtMs, cooldownHoldMs) {
  clearInterval(countdownTimer);
  btn.disabled = true;
  skipCooldown.show('Hold to ask now', cooldownHoldMs);
  countdownTimer = setInterval(() => {
    const remaining = Math.max(0, retryAtMs - Date.now());
    if (remaining <= 0) {
      clearInterval(countdownTimer);
      btn.disabled = false;
      skipCooldown.hide();
      status.textContent = '';
      return;
    }
    status.textContent = `You just asked — try again in ${Math.ceil(remaining / 1000)}s, or hold below to ask now anyway`;
  }, 250);
}

// Shared by both the normal "Request access" click and skip-cooldown's hold
// — both end up asking the bandit for a real decision, just via a different
// path to get there.
function handleAccessResult(response) {
  if (response.granted) {
    status.textContent = `Granted for ${response.durationMin} minute${response.durationMin === 1 ? '' : 's'} — redirecting…`;
    skipCooldown.hide();
    goToTarget();
    return;
  }

  if (response.cooldown) {
    // Shouldn't normally happen from a skip-cooldown call, but stay consistent if it does.
    startCooldownCountdown(response.retryAtMs, response.cooldownHoldMs);
    return;
  }

  status.textContent = 'Not granted this time.';
  btn.disabled = false;
  skipCooldown.hide();
  armOverrideButton(response.overrideDelaySec, response.overrideHoldMs);
}

btn.addEventListener('click', async () => {
  btn.disabled = true;
  override.hide();
  skipCooldown.hide();
  clearInterval(overrideDelayTimer);
  clearInterval(countdownTimer);
  status.textContent = 'Thinking…';
  const response = await chrome.runtime.sendMessage({ type: 'REQUEST_ACCESS', hostname, targetUrl });
  handleAccessResult(response);
});

// ---- extend ("Continue watching" after an extremely long session ended) ----

const extendBtn = document.getElementById('extendBtn');
const extend = makeHoldButton(extendBtn, {
  label: 'Hold to continue',
  onFire: async () => {
    status.textContent = 'Continuing…';
    const response = await chrome.runtime.sendMessage({ type: 'EXTEND_SESSION', hostname, targetUrl });

    if (response.granted) {
      status.textContent = `Continuing for ${response.durationMin} minutes — redirecting…`;
      extend.hide();
      override.hide();
      clearInterval(overrideDelayTimer);
      goToTarget();
      return;
    }

    extend.hide();
  },
});

(async () => {
  const { eligible, holdMs } = await chrome.runtime.sendMessage({ type: 'GET_EXTEND_ELIGIBILITY', hostname });
  if (eligible) extend.show(undefined, holdMs);
})();
