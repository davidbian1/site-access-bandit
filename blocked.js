const params = new URLSearchParams(location.search);
const hostname = params.get('site') || '';
const targetUrl = params.get('target') || `https://${hostname}/`;

document.getElementById('site').textContent = hostname;

const btn = document.getElementById('requestBtn');
const status = document.getElementById('status');

let countdownTimer = null;

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

// Shared press-and-hold interaction: a button that requires a sustained hold
// (not a click) to fire, with a visible fill animation, so it can't be
// tapped through on reflex. Used for both the override and extend buttons.
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
let overrideDelayTimer = null;

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

btn.addEventListener('click', async () => {
  btn.disabled = true;
  override.hide();
  clearInterval(overrideDelayTimer);
  status.textContent = 'Thinking…';
  const response = await chrome.runtime.sendMessage({ type: 'REQUEST_ACCESS', hostname, targetUrl });

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
