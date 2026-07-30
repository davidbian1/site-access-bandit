// Runs in the page's own MAIN world (not the extension's isolated world),
// which is required for this to actually see the page's real pushState/
// replaceState calls — an override installed from the isolated world only
// patches a copy nothing else ever calls. Has no access to chrome.* APIs by
// design, so it just re-broadcasts every navigation as a DOM event for
// content.js (isolated world) to pick up and act on.

(function () {
  const origPushState = history.pushState;
  const origReplaceState = history.replaceState;

  function notify() {
    window.dispatchEvent(new CustomEvent('__mab_navigate', { detail: location.href }));
  }

  history.pushState = function (...args) {
    const result = origPushState.apply(this, args);
    notify();
    return result;
  };

  history.replaceState = function (...args) {
    const result = origReplaceState.apply(this, args);
    notify();
    return result;
  };
})();
