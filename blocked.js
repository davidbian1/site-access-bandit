import { isTrustedTarget } from './lib/config.js';

const params = new URLSearchParams(location.search);
const hostname = params.get('site') || '';
const fallbackTarget = `https://${hostname}/`;
const requestedTarget = params.get('target');
// This page is web-accessible from any origin (a managed site can be any
// domain), so `target` has to be treated as untrusted input, not just
// "whatever our own code put there" - see isTrustedTarget's comment in
// lib/config.js. A mismatched target falls back to the site's own root
// rather than being used at all.
const targetUrl = requestedTarget && isTrustedTarget(requestedTarget, hostname) ? requestedTarget : fallbackTarget;

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
function makeHoldButton(el, { label, onFire, onHoldStart }) {
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

  function startHold(e) {
    if (el.disabled || firing) return;
    e.preventDefault();
    // Capture the pointer so this element keeps getting its move/up events
    // even if the cursor drifts outside its bounds mid-hold - over a
    // multi-second hold that's normal hand movement, not a release, and
    // without capture it fires a plain mouseleave/pointerleave that would
    // cancel a hold the user never actually let go of.
    el.setPointerCapture(e.pointerId);
    holding = true;
    el.classList.add('holding');
    fill.style.transitionDuration = `${holdMs}ms`;
    holdTimer = setTimeout(() => {
      if (holding) fire();
    }, holdMs);
    if (onHoldStart) onHoldStart();
  }

  async function fire() {
    if (firing) return;
    firing = true;
    el.disabled = true;
    await onFire();
    firing = false;
  }

  el.addEventListener('pointerdown', startHold);
  el.addEventListener('pointerup', cancelHold);
  el.addEventListener('pointercancel', cancelHold);

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
    isHolding() {
      return holding;
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
  // The countdown interval below re-renders "You just asked — try again in
  // Xs" every 250ms independent of whether a hold is in progress. Without
  // this, that message keeps contradicting the button's own fill animation
  // for the entire hold — it visibly fills while the text right above it
  // keeps insisting you're still just waiting, which reads as "this isn't
  // doing anything" even though the hold itself is working correctly.
  onHoldStart: () => {
    status.textContent = 'Asking now — keep holding…';
  },
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
      // A hold already in progress should get to finish and fire rather
      // than having the button yanked out from under it just because the
      // natural cooldown clock ran out mid-hold. If it fires, onFire clears
      // this interval itself; if it's released without firing, keep
      // polling until it's no longer in progress before restoring state -
      // don't clear the interval on this branch, only on the one below.
      if (skipCooldown.isHolding()) return;
      clearInterval(countdownTimer);
      btn.disabled = false;
      skipCooldown.hide();
      status.textContent = '';
      return;
    }
    // Don't stomp over the "keep holding…" message from onHoldStart while a
    // hold is actually in progress — this message and that one would
    // otherwise alternate every 250ms, undercutting the fill animation's
    // own effort feedback.
    if (!skipCooldown.isHolding()) {
      status.textContent = `You just asked — try again in ${Math.ceil(remaining / 1000)}s, or hold below to ask now anyway`;
    }
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

  if (response.onBreak) {
    skipCooldown.hide();
    checkBreak();
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

    status.textContent = response.error === 'no extend offer available'
      ? 'That offer expired — try Request access instead.'
      : "Couldn't continue — try Request access instead.";
    extend.hide();
  },
});

// ---- take a break override (proactive, cross-site block) ----

const overrideBreakBtn = document.getElementById('overrideBreakBtn');
let breakDelayTimer = null;

const overrideBreak = makeHoldButton(overrideBreakBtn, {
  label: 'Hold to override break',
  onFire: async () => {
    status.textContent = 'Overriding break…';
    const response = await chrome.runtime.sendMessage({ type: 'OVERRIDE_BREAK' });
    if (response.ok) {
      status.textContent = 'Break ended — you can request access again.';
      overrideBreak.hide();
      clearInterval(breakDelayTimer);
      btn.disabled = false;
      btn.style.display = 'inline-block';
    } else {
      status.textContent = "Couldn't override — the break may have already ended.";
      checkBreak();
    }
  },
});

// Same wait-then-hold shape as the ordinary per-site override, but flat (no
// ramp, no discount for banked trust) and deliberately longer by default —
// see DEFAULT_BREAK_OVERRIDE_DELAY_SEC/HOLD_MS in lib/config.js.
function armOverrideBreakButton(delaySec, holdMs) {
  overrideBreakBtn.style.display = 'inline-block';
  overrideBreakBtn.disabled = true;
  clearInterval(breakDelayTimer);
  let remaining = Math.ceil(delaySec || 0);
  const tick = () => {
    if (remaining <= 0) {
      clearInterval(breakDelayTimer);
      overrideBreak.show(`Hold to override break (${Math.round((holdMs || 3000) / 1000)}s)`, holdMs);
      return;
    }
    overrideBreak.setLabel(`Override break (available in ${remaining}s)`);
    remaining -= 1;
  };
  tick();
  breakDelayTimer = setInterval(tick, 1000);
}

// Returns whether a break is currently active, and updates the page to
// match either way — called on load and again after a break-blocked
// request or a failed override, so the page never gets stuck showing
// controls that don't match the current state.
async function checkBreak() {
  const breakStatus = await chrome.runtime.sendMessage({ type: 'GET_BREAK_STATUS' });
  if (!breakStatus.active) {
    overrideBreak.hide();
    clearInterval(breakDelayTimer);
    return false;
  }
  btn.disabled = true;
  override.hide();
  skipCooldown.hide();
  extend.hide();
  clearInterval(overrideDelayTimer);
  clearInterval(countdownTimer);
  const remainingMin = Math.max(1, Math.ceil((breakStatus.breakUntil - Date.now()) / 60000));
  status.textContent = `You're on a break — ${remainingMin} minute${remainingMin === 1 ? '' : 's'} remaining.`;
  armOverrideBreakButton(breakStatus.overrideDelaySec, breakStatus.overrideHoldMs);
  return true;
}

(async () => {
  const onBreak = await checkBreak();
  if (onBreak) return; // a break in progress supersedes the extend offer
  const { eligible, holdMs } = await chrome.runtime.sendMessage({ type: 'GET_EXTEND_ELIGIBILITY', hostname });
  if (eligible) extend.show(undefined, holdMs);
})();
