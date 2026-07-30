// Runs in the isolated world (has chrome.* API access). A grant only ever
// covers the one page it was requested for — the moment the page navigates
// to anything else, this ends that grant and sends the tab back through the
// blocked page so the next destination gets its own fresh bandit decision.
// Two exceptions, both meant to avoid interrupting more than the point of
// gating actually requires:
//  - right after a successful override, there's a grace window (see
//    background.js's OVERRIDE_DENY handler) where this re-gating is
//    suspended, so the effort spent getting through the override actually
//    buys some real browsing instead of ending on the very next click.
//  - if you dwelled on the page you're leaving long enough to look like
//    genuine long-form viewing rather than compulsive scrolling (see
//    background.js's longFormDwellMin), the next navigation is let through
//    too — a 40-minute documentary followed by a related video shouldn't be
//    gated the same way a string of 15-second clips is.
//
// Real navigation-call detection happens in content-main.js, which runs in
// the page's own MAIN world (isolated-world overrides of history.pushState/
// replaceState never see calls made by the page's own script) and rebroadcasts
// every call as a '__mab_navigate' DOM event, which is visible across the
// isolated/main world boundary like any other DOM event.

(function () {
  let redirecting = false;
  let lastUrl = location.href;
  let pageEnteredAt = Date.now();

  function currentHostname() {
    return location.hostname.replace(/^www\./, '');
  }

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

  async function handleNavigate(url) {
    if (redirecting || !url || url === lastUrl) return;
    lastUrl = url;
    const dwellMs = Date.now() - pageEnteredAt;
    try {
      const status = await chrome.runtime.sendMessage({ type: 'CHECK_ACCESS', hostname: currentHostname(), dwellMs });
      if (status && (status.grace || status.longFormDwell)) {
        pageEnteredAt = Date.now(); // let it through, but the clock resets for the new page
        return;
      }
    } catch {
      // extension context invalidated — fall through to re-gating below
    }
    endCurrentSessionAndBlock(url);
  }

  window.addEventListener('__mab_navigate', (e) => handleNavigate(e.detail));
  window.addEventListener('popstate', () => handleNavigate(location.href));

  // Fast fallback for routing that changes the URL without going through
  // history.pushState/replaceState/popstate at all.
  setInterval(() => handleNavigate(location.href), 300);

  // Initial load: confirm there's actually a live grant covering this exact
  // page (guards against edge cases where a page loaded without going
  // through the normal blocked-page -> request-access flow).
  (async () => {
    try {
      const status = await chrome.runtime.sendMessage({ type: 'CHECK_ACCESS', hostname: currentHostname() });
      if (!status || !status.granted) goToBlockedPage(location.href);
    } catch {
      // extension context invalidated (reload/update) — nothing to enforce
    }
  })();
})();
