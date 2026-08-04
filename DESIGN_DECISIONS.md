# Hygiene review — design decisions

This document explains a small round of engineering-hygiene changes made
to this repo, and — just as importantly — what was deliberately *not*
changed and why. It's written for someone (you) revisiting this later, or
walking an interviewer through it.

## Starting point: what this repo already had right

Before touching anything, I audited the repo against a standard hygiene
checklist (gitignore, dependency manifest, file layout, tests, license).
Almost all of it was already in place:

- `.gitignore` already covered what this project actually generates
  (`node_modules/`, logs, OS cruft) — there's no `*.png` output or model
  checkpoint to ignore because this isn't that kind of project.
- `LICENSE` (MIT) already existed.
- `package.json` already declared zero runtime dependencies, correctly —
  this is a Manifest V3 extension with no build step by design.
- `lib/config.test.js` and `lib/linucb.test.js` already covered the bandit
  math and the reward/cooldown/trust/override formulas, run via Node's
  built-in `node:test` (no framework dependency).
- `.github/workflows/test.yml` already ran that suite plus a manifest.json
  sanity check on every push/PR.
- `lib/linucb.js` (bandit) and `lib/config.js` (constants/reward/context)
  were already split out of the UI/background code.

**I'm calling this out explicitly rather than manufacturing a gitignore
or license commit anyway** — a checklist you already pass doesn't need
performative commits to prove it. The changes below are the things that
were actually worth fixing.

## Changes made

### 1. Extract pure helpers out of `background.js` — `lib/background-helpers.js`

**What:** Moved `recentStatsFor`, `makeGrant`, `ruleIdFor`, and
`escapeRegex` out of `background.js` into their own module.

**Why:** These four functions don't touch any `chrome.*` API — they're
plain data transforms. But `background.js` itself registers
`chrome.alarms.onAlarm` and `chrome.runtime.onMessage` listeners at
module load time, so importing it anywhere outside a real extension
context (e.g. a Node test) throws immediately. That made these functions
untestable even though they were the most test-worthy logic in the file
— window-filtering math (`recentStatsFor`) is exactly the kind of thing
that silently drifts wrong when someone tweaks a threshold. Splitting
"pure logic" from "chrome.\* glue" is the same boundary `lib/config.js`
already drew for the reward/cooldown/trust math; this just extends it to
cover the pieces that were still stuck inside the service worker file.

**Trade-off considered:** I left the message router in
`background.js` (the big `switch` in `chrome.runtime.onMessage`) alone.
It's long, but every branch is a straight line of chrome-API calls with
no reusable logic to extract — splitting it into command classes would
be adding structure the code doesn't need, not removing complexity. I'm
flagging it here because a reviewer glancing at line count might ask
about it; I don't think it's actually a problem.

### 2. Add `lib/background-helpers.test.js`

**What:** Ten unit tests covering `recentStatsFor`'s window math
(24h / frequency-window / override-window filtering, per-hostname
isolation, the 5-session average), `ruleIdFor`'s assign-vs-reuse
behavior, `makeGrant`'s `expiresAt` calculation, and `escapeRegex`.

**Why:** Direct consequence of #1 — the whole point of extracting these
was to make them testable, so leaving them uncovered afterward would
have wasted the extraction. `recentStatsFor` in particular has several
off-by-one-prone boundaries (window edges, "last 5" truncation) that are
easy to get subtly wrong on a future edit and hard to notice by manual
testing, since the symptom would be the bandit learning from slightly
wrong context/frequency numbers rather than a visible crash.

### 3. De-duplicate hostname parsing — `popup.js` / `options.js` now import from `lib/config.js`

**What:** `popup.js` and `options.js` each had their own copy-pasted
`hostnameFromUrl` / `normalizeHostname` function, identical to the ones
already exported by `lib/config.js` (which `background.js` already
imports). Converted both scripts to ES modules (`type="module"` on the
`<script>` tag in `popup.html` / `options.html`) so they can import the
shared implementation instead.

**Why:** Three copies of the same regex-based hostname logic meant a
future fix to one (say, how the leading `www.` gets stripped, or
handling IDN hosts) had no mechanism to propagate to the other two —
they'd silently diverge. This is the textbook case for DRY: not "less
typing," but "one place that can be wrong instead of three."

**Why this was safe to do:** `popup.html`/`options.html` are extension
pages loaded from `chrome-extension://<id>/…`, so importing another file
from the same extension package doesn't need `web_accessible_resources`
or any manifest change — that permission gate is for resources fetched
by *external* web pages, not the extension's own pages importing its own
modules. `package.json` already has `"type": "module"`, and
`background.js` already runs as an ES module service worker, so this
just extends a pattern already in use rather than introducing a new one.

**Deliberately not touched:** `content.js` and `content-main.js` (the
content scripts injected into managed sites) also have a tiny inline
`www.`-stripping helper, duplicated a third time there. I left it alone.
Content scripts registered dynamically via
`chrome.scripting.registerContentScripts` don't get the same
straightforward `type="module"` treatment as a `<script>` tag — making
them importable would mean restructuring how they're registered, which
is real risk (these are the pieces that actually enforce blocking, and I
can't fully verify a loaded-extension behavior change in this
environment) for a one-line duplicated regex. Not worth it. If you ever
touch that regex, remember it exists in three places, one of which is
this one.

### 4. Replace `innerHTML` template strings with DOM construction in `options.js`

**What:** The managed-sites table, the bandit-debug table, and the
session-history table in `options.js` all built `<tr>` contents by
interpolating values directly into an `innerHTML` template string.
Replaced all three with `createElement`/`textContent`.

**Why:** Every value going through that path today is either
extension-controlled (session decision enums, formatted numbers) or a
hostname — and `URL().hostname` already restricts hostnames to a
character set that can't break out of an HTML tag, so this wasn't
exploitable *right now*. But it's a fragile pattern to leave standing:
`popup.js`, sitting right next to it, already builds equivalent rows
safely with `createElement`, so `options.js` was the odd one out for no
reason. If a future change ever routes free-text (a note field, a custom
label) through one of these tables, the `innerHTML` version becomes an
XSS bug on day one; the DOM-construction version can't be, by
construction. This is defense-in-depth, not a fix for a live
vulnerability — I want to be precise about that rather than overstate
it.

### 5. Fix a silent-failure UX bug in `blocked.js`'s extend flow

**What:** Clicking "Continue watching" sets status text to
`"Continuing…"` before sending `EXTEND_SESSION`. On success it updates
the text; on failure (the offer already expired, or you lost the race
with its own window) the old code just hid the button and left
`"Continuing…"` on screen — which reads as the extension being stuck,
not as "that didn't work, try something else." Added a real failure
message.

**Why:** This is a genuine (if minor) correctness bug, not a hygiene
nit — the UI was lying about its own state. Small blast radius (one
rarely-hit failure path), but cheap and unambiguous to fix, so I fixed
it rather than just noting it.

### 6. README: document `lib/background-helpers.js`

Small follow-up to #1 — the README's "Files" section enumerates every
module in `lib/`; the new one was missing. No content changes beyond
that addition.

## What I did not touch, and why

- **The reward function, bandit math, and all default constants** —
  explicitly out of scope per your instructions, and I didn't see
  anything I'd call a bug in them anyway (the existing test suite already
  pins the important invariants: rewards never positive on a grant,
  cooldown clamps, override delay ramps correctly).
- **The 300ms `setInterval` polling fallback in `content.js`** (for
  routing changes that don't go through `pushState`/`replaceState`/
  `popstate`). This has a real, if small, battery/CPU cost on every
  managed-site tab for as long as it's open. I'm flagging it rather than
  changing it because it reads as a deliberate trade-off (catching
  routing patterns the three real hooks miss) rather than an oversight,
  and touching it changes enforcement *behavior*, not just structure —
  that's a call for you, not a hygiene fix.
- **The message-router `switch` in `background.js`** — see #1's
  trade-off note above.
- **Converting `content.js`/`content-main.js` to modules** — see #3's
  trade-off note above.

## Questions for you

1. Do you want the `content.js` polling interval addressed (e.g. reduced
   frequency, or documented as an intentional trade-off in the README's
   "Known limitations" section)? I left it as-is since it changes runtime
   behavior.
2. I could not load the unpacked extension in this environment to
   click-test the popup/options pages after the `type="module"` change.
   The logic is syntax-checked and the existing test suite passes, but
   please reload the extension in `edge://extensions` and open the popup
   and options page once to confirm no console errors — this is exactly
   the category of thing the README already calls out as needing manual
   verification.
