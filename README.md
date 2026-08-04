# Mindful Access Bandit

A Manifest V3 Edge/Chromium extension that uses a contextual bandit to
decide, each time you try to visit a site you've chosen to restrict,
whether to grant brief, time-limited access — and learns from what you
actually do with it. Everything stays in `chrome.storage.local`; nothing
leaves your device.

See [DESIGN.md](DESIGN.md) for how the bandit, reward function, and
gating mechanics actually work, and why.

## What it does

- You choose which sites to manage, from the popup or options page.
- Visiting a managed site redirects you to a local "Access limited" page
  instead of loading it.
- "Request access" asks a per-site bandit model for a decision: deny, or
  grant for a few minutes. A denial isn't permanent — a short adaptive
  cooldown and you can ask again, or spend a moment of effort to skip
  the wait instead of watching a clock.
- If denied and you genuinely need the page, "I really need this" is a
  deliberately effortful override (a wait, then a press-and-hold), not a
  one-tap escape hatch.
- Access is granted per page, not per site — navigating to a new page,
  including client-side routing (e.g. the next video in a feed),
  triggers a fresh decision. Unusually long sessions get one narrow,
  effortful "continue watching" exception.
- The model updates after every session based on how long you actually
  stayed, so it adapts over time to when and how you actually use each
  site.

## Install (unpacked, developer mode)

1. Open `edge://extensions`.
2. Turn on **Developer mode** (bottom-left toggle).
3. Click **Load unpacked** and select this folder.
4. Click the extension icon, add a site you want to restrict, and try
   visiting it.

## Usage

- **Popup** (toolbar icon): manage the current tab's site, see or end an
  active grant, view your list of managed sites.
- **Options page**: full site list, bandit/reward parameters (all
  editable), per-site bandit debug view, and session history.

## Development

Requires Node 18+ — only for running tests and linting. The extension
itself has zero runtime dependencies and no build step; `Load unpacked`
runs the source files directly.

```
npm install
npm test
npm run lint
```

Both run in CI on every push and PR. See [DESIGN.md](DESIGN.md#code-layout)
for what each file does and what the test suite covers.

## Known limitations (MVP scope)

- Blocking only covers top-level (`main_frame`) navigations, not iframes.
- Active-time tracking samples on a timer rather than every focus/
  visibility event, so it's an approximation.
- Each managed site gets its own independent bandit model — no sharing
  of learned weights across sites.

## License

MIT — see [LICENSE](LICENSE).
