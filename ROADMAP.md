# Roadmap to shipping

What's left before Mindful Access Bandit is something a real user (starting
with its own developer) can install and trust day to day, and — separately —
what's left before it's published on the Chrome Web Store for anyone else.
Grouped by why each item matters, not by file touched; each item states
what's already true, what needs to happen, and roughly how big a chunk of
work it is.

This is a living document. Items move to "Done" as they land; nothing gets
deleted from history — mirrors the convention `AUDIT.md` and the ADRs
already follow.

---

## 0. Where things stand today

**Built and covered by automated tests:** the core LinUCB decision loop,
per-navigation re-gating, override/extend/grace mechanics, trust decay,
cross-site warm-start, discounting, the learning-trends view, disabled-time
reconstruction, take-a-break with a learned duration bandit. 68 JS tests
(`node --test`), 39 Python tests (`pytest eval/`), ESLint clean, all
running in CI on every push.

**Never run in an actual browser.** Every one of the above has been
verified by unit tests and offline simulation, never by loading the
unpacked extension in Chrome/Edge and clicking through it. This is the
single largest gap between "the logic is correct" and "the extension
works" — see §1.

**Zero calibration against real usage.** `DEFAULT_ALPHA`, the break
bandit's settings, all of it — tuned against synthetic simulated
environments (ADRs 0001–0003), never against this extension's own logged
sessions, because until the last session there was no way to get sessions
out of `chrome.storage.local` at all. That gap just closed (§3) but the
calibration step itself hasn't happened yet.

**Not packaged for distribution.** No icons, no privacy policy, no Chrome
Web Store listing, no CD pipeline. See §4–§6.

---

## 1. Manual browser QA — do this first, before anything else

**Why it's first:** everything downstream (a real user relying on it daily,
a Web Store submission, a CD pipeline) assumes the extension actually works
end-to-end in a real browser. That assumption has never been tested.

**What to do:** load the unpacked extension (`chrome://extensions` →
Developer mode → Load unpacked) and walk through, on a real managed site:

1. Add a site, confirm it's immediately blocked (DNR rule + registered
   content scripts, including an already-open tab getting redirected).
2. Request access, get granted, confirm the grant actually expires and
   re-gates on the next navigation.
3. Get denied, wait out the override delay, hold the override button,
   confirm access and confirm the grace window actually lets a few
   navigations through before re-gating.
4. Let a session run long enough to hit `longFormDwellMin`/
   `extremeLongFormMin`, confirm the silent re-draw and the "continue
   watching" offer both appear and both work.
5. Start a take-a-break from the popup (confirm the chips appear, confirm
   an in-progress grant actually ends), let it run to completion, confirm
   a second one gets overridden correctly from the blocked page with the
   steeper wait/hold.
6. Disable the extension for a few minutes with a managed site open in
   another tab, re-enable it, confirm the unmonitored-gap reconstruction
   shows up in the trends table (needs the `history` permission actually
   granted — Chrome will prompt on first load after this permission was
   added).
7. Open the options page, exercise every settings field, the debug tables
   (both bandits), session export, and clear-history.

**Size:** one focused sitting, ~45–60 minutes. This is not a "nice to have
eventually" item — no other roadmap item here should be treated as done
until this pass has happened at least once.

**Status:** not started.

---

## 2. Real-data calibration

**Why it matters:** ADR 0001 found the shipped `alpha=1.0` produces ~80x
more regret than a tuned value *in simulation*, and explicitly declined to
change the live default on synthetic evidence alone. ADR 0003's break
bandit shipped with an even more conservative, deliberately-unvalidated
default for the same reason. Both ADRs name the same next step.

**What to do:**
1. Use real usage for a while (this now doubles as part of §1's QA pass)
   until there are a non-trivial number of logged sessions.
2. Export sessions from the options page (shipped — see the "Export as
   JSON" button in Session history).
3. Adapt `eval/tune.py`'s Optuna sweep to load real exported sessions
   instead of `simulate.py`'s synthetic environment as its objective —
   this is new code, not a config flag; the objective function needs to
   replay logged `(context, arm, reward)` tuples rather than simulate
   them.
4. If the tuned values differ meaningfully from the shipped defaults,
   update `DEFAULT_ALPHA`/`DEFAULT_DISCOUNT_FACTOR` (and the break
   bandit's equivalents once it has enough data of its own) with a new ADR
   documenting what changed and why, following the exact precedent ADR
   0001 already set for this.

**Size:** a few hours of `eval/` work once there's enough real data to
make it meaningful — this is gated on time-in-use, not engineering effort.

**Status:** export tooling shipped; the calibration pass itself not
started (needs real usage history to exist first).

---

## 3. Packaging for the Chrome Web Store

**Why it matters:** hard requirements for submission, unrelated to whether
the code works.

**What to do:**
- **Icons.** No `icons` field in `manifest.json`, no icon files anywhere in
  the repo (only `assets/demo.gif`). Chrome Web Store requires at minimum
  a 128×128 PNG for the listing, and a declared `icons` map (16/32/48/128)
  is strongly recommended so the toolbar and extensions page don't show a
  generic puzzle-piece icon. This is a design decision, not an engineering
  one — needs actual artwork (or a simple deliberate mark) picked by
  whoever's shipping this, not guessed at here.
- **Privacy policy.** The `history` and `tabs` permissions (and the broad
  `optional_host_permissions: ["*://*/*"]`) require a privacy policy URL
  in the Web Store listing. The honest answer is short and genuinely
  reassuring — everything is local, nothing is transmitted anywhere, no
  analytics, no accounts — but it needs to actually be written and hosted
  somewhere reachable by URL (a `PRIVACY.md` rendered via GitHub Pages, or
  a one-page site, is enough; no separate infrastructure needed for this).
- **Listing copy and screenshots.** Short and long description, at least
  one 1280×800 or 640×400 screenshot, a category. `README.md`'s existing
  description and `assets/demo.gif` are most of the raw material already.
- **Developer account.** One-time $5 Chrome Web Store developer
  registration fee, tied to a Google account.

**Size:** a few hours total, mostly writing and one round of icon/screenshot
work — no code changes beyond adding the `icons` manifest field once
artwork exists.

**Status:** not started.

---

## 4. Submission and review

**What to do:** package (`zip` the repo minus dev-only files — `eval/`,
`docs/`, test files, `node_modules`, the gitignored local docs — a
`.webstorepackageignore`-equivalent build step is worth adding here),
upload through the Chrome Web Store Developer Dashboard, submit for
review.

**Timeline to expect:** Google's typical review window is a few hours to a
few business days for a new extension with this permission profile
(`history` plus broad optional host permissions tend to draw closer review
than a narrow-permission extension, though nothing here should trigger a
rejection on its own — the behavior matches what the permissions justify).
Budget up to a week to be safe, and expect at least one round of
clarifying questions or a rejection-with-reason on a permission
justification, which is normal for a first submission and not a sign
anything is wrong.

**Status:** blocked on §3.

---

## 5. Continuous deployment

**Why it matters:** was raised earlier as wanting the published extension
and its CD pipeline to double as a visible "proof of execution" artifact —
that only means something if updates actually flow through an automated,
auditable pipeline rather than manual uploads.

**What to do:**
- A GitHub Actions workflow (separate from the existing `test.yml`)
  triggered on a version tag or a manual `workflow_dispatch`, running
  `chrome-webstore-upload-cli` against the Chrome Web Store's publish API.
- Needs a one-time OAuth setup (client ID/secret, refresh token) stored as
  repo secrets — this is account-linking, not something to script blindly;
  follow `chrome-webstore-upload-cli`'s own setup docs when this is
  reached.
- **Gate publishing behind a manual approval step** (a GitHub Environment
  with a required reviewer, or simply never wiring the trigger to run
  automatically on every push to `master`) — this was flagged earlier as
  a concrete mitigation against shipping an AI-assisted change straight to
  real users without a human actually looking at it first. The test suite
  passing is necessary, not sufficient, for a publish to happen.

**Size:** half a day, mostly the one-time OAuth dance.

**Status:** not started; blocked on §3–§4 (nothing to deploy to yet).

---

## 6. Beta rollout

**Why it matters:** the stated goal is for this to be genuinely useful to
people other than its own developer, not just a resume artifact — that
needs real outside feedback, which needs real outside users, carefully.

**What to do:**
1. Ship to a small trust circle first — a handful of people who'll
   actually give honest feedback, not a public launch — using the Chrome
   Web Store's "unlisted" or "trusted testers" visibility option rather
   than public listing on day one.
2. Keep every default conservative and opt-in exactly as it ships today
   (nothing here should change for beta specifically) — the extension
   already defaults to friction-favoring settings (deny-biased reward,
   generous cooldowns) rather than anything aggressive.
3. Collect feedback specifically on the two things that can't be verified
   any other way: does the bandit's behavior feel reasonable in real daily
   use, and does the take-a-break suggestion timing feel right or
   naggy/absent. Both are exactly the kind of thing §2's real-data
   calibration exists to eventually fix.
4. Only after that feedback loop, consider public listing.

**Size:** ongoing, not a one-time task.

**Status:** blocked on §1 (nothing should go to another human before a
manual QA pass has happened at least once) and §4.

---

## 7. Explicitly not recommended right now

Called out so these don't get treated as gaps by omission:

- **Any cloud provider (GCP/AWS/Azure).** Already discussed and rejected —
  nothing here needs a backend; everything is local by design.
- **Multi-user accounts, sync, or server-side analytics.** Would change
  the privacy story from "nothing leaves the device" to something that
  needs its own design and its own privacy policy section — out of scope
  unless a specific need for it shows up.
- **A public listing before a beta round.** However tempting as a
  portfolio milestone, shipping straight to public without §1 and §6's
  feedback loop is exactly the AI-over-reliance risk raised earlier —
  worth resisting even once §3–§5 are technically ready.

---

## Suggested order

§1 (QA) → §2 starts accumulating data in parallel with everyday use → §3
(packaging) → §4 (submit) → §5 (CD) → §6 (beta) → public listing. §2 is the
one item with no fixed finish line — it keeps improving as more real usage
accumulates, independent of where the others land.
