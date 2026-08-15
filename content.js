// Runs in the isolated world (has chrome.* API access). A grant only ever
// covers the one page it was requested for — the moment the page navigates
// to anything else, this ends that grant and sends the tab back through the
// blocked page so the next destination gets its own fresh bandit decision.
// That's the default for every navigation, with exactly one exception: an
// active grace credit (see background.js's consumeGrace) — banked either by
// a successful override, or by spending the same wait-and-hold effort to
// "extend" an extremely long session (see blocked.js) — lets a navigation
// through without re-gating. Each use spends one hop of that credit; there
// is no automatic, effort-free pass-through.
//
// Real navigation-call detection happens in content-main.js, which runs in
// the page's own MAIN world (isolated-world overrides of history.pushState/
// replaceState never see calls made by the page's own script) and rebroadcasts
// every call as a '__mab_navigate' DOM event, which is visible across the
// isolated/main world boundary like any other DOM event.

(function () {
  let redirecting = false;
  let lastUrl = location.href;

  function currentHostname() {
    return location.hostname.replace(/^www\./, '');
  }

  // Lets background.js check "is enforcement already running in this tab"
  // (chrome.tabs.sendMessage rejects if nothing answers) before deciding
  // whether to (re-)inject — see reconcileOpenTabs in background.js for why
  // that matters after the extension is disabled and re-enabled.
  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg.type === 'PING') sendResponse({ alive: true });
  });

  function goToBlockedPage(targetUrl) {
    if (redirecting) return;
    redirecting = true;
    location.href = chrome.runtime.getURL(
      `blocked.html?site=${encodeURIComponent(currentHostname())}&target=${encodeURIComponent(targetUrl)}`
    );
  }

  function endCurrentSessionAndBlock(targetUrl) {
    chrome.runtime.sendMessage({ type: 'END_SESSION', hostname: currentHostname(), reason: 'navigated' }).catch(() => {});
    goToBlockedPage(targetUrl);
  }

  // Debounced: some sites rewrite the URL (a query param, a hash) for
  // reasons that have nothing to do with the user actually navigating -
  // analytics tokens, scroll-position anchors, session state. Reacting to
  // every one of those instantly ends a still-valid grant over a change
  // that isn't really a new page. Waiting a short window for the URL to
  // settle before acting filters out a single transient blip without
  // meaningfully delaying enforcement of a real, sustained navigation.
  const NAVIGATE_DEBOUNCE_MS = 500;
  let debounceTimer = null;
  let debouncedUrl = null;

  function scheduleNavigate(url) {
    if (redirecting || !url || url === lastUrl) return;
    debouncedUrl = url;
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      if (debouncedUrl === location.href) handleNavigate(debouncedUrl);
    }, NAVIGATE_DEBOUNCE_MS);
  }

  async function handleNavigate(url) {
    if (redirecting || !url || url === lastUrl) return;
    lastUrl = url;
    try {
      const status = await chrome.runtime.sendMessage({ type: 'CHECK_ACCESS', hostname: currentHostname(), url, consume: true });
      if (status && status.grace) return; // spent a hop of banked grace — let it through
      if (status && status.granted) return; // still the same sub-URL the grant actually covers
    } catch {
      // extension context invalidated — fall through to re-gating below
    }
    endCurrentSessionAndBlock(url);
  }

  window.addEventListener('__mab_navigate', (e) => scheduleNavigate(e.detail));
  window.addEventListener('popstate', () => scheduleNavigate(location.href));

  // Fast fallback for routing that changes the URL without going through
  // history.pushState/replaceState/popstate at all.
  setInterval(() => scheduleNavigate(location.href), 300);

  // Initial load: confirm there's actually a live grant (or grace credit)
  // covering this exact page. Non-consuming — just a peek, not a hop spend.
  (async () => {
    try {
      const status = await chrome.runtime.sendMessage({ type: 'CHECK_ACCESS', hostname: currentHostname(), url: location.href });
      if (!status || !status.granted) goToBlockedPage(location.href);
    } catch {
      // extension context invalidated (reload/update) — nothing to enforce
    }
  })();
})();
