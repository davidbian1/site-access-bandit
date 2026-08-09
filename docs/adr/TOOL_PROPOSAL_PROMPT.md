# Tool/feature proposal prompt

Use this before adding any tool or dependency not already in this repo — it's
the mechanism behind the convention in `docs/adr/README.md`. Fill in
`{{FEATURE}}`, send the whole thing to an LLM (or answer it yourself), and
paste the result into a new `docs/adr/000N-{{feature-slug}}.md`.

The point of routing this through a prompt instead of just deciding in your
head is the same reason code review exists: it forces the justification to
be written down and checkable *before* the implementation exists to defend
itself, not after.

---

## The prompt

```
You are acting as a skeptical staff engineer reviewing a proposal to add
{{FEATURE}} to Mindful Access Bandit — a solo-maintained, single-user
Manifest V3 browser extension. It implements a disjoint LinUCB contextual
bandit (lib/linucb.js) that decides whether to grant time-limited access to
sites the user has chosen to restrict, learning from a hand-shaped reward
function (lib/config.js). There is a companion Python eval/ harness
(NumPy, Optuna, Matplotlib, pytest, Jupyter/nbconvert) used to simulate and
tune the bandit offline. No backend, no multi-user infrastructure, no
production deployment — it runs entirely in one person's browser.

Context you must use, not ignore:
- Current stack: vanilla JS (no build step, no framework), Node's built-in
  test runner, ESLint, GitHub Actions CI, and the Python eval/ tools listed
  above. Nothing else.
- Already considered and rejected, for lack of a stated need: Kubernetes,
  MLflow, a model-serving framework (TorchServe/Ray Serve), a managed cloud
  ML platform (SageMaker/Vertex AI), Prometheus/Grafana, and ML-specific
  drift-detection tooling (Evidently AI/Arize). See docs/adr/0001 for the
  reasoning already on record — don't repeat an argument that's already
  been made there unless {{FEATURE}} changes it.
- Convention: every new tool gets its own ADR, written BEFORE
  implementation, that would survive an interviewer asking "why does your
  side project need this." A true-but-generic answer ("it's an in-demand
  industry skill") does not clear that bar on its own.

Answer in this order. Do not write the HOW section if the WHY section's
verdict isn't "justified now" — a plan for something unjustified is exactly
the pattern this process exists to prevent.

## 1. WHY
- What specific, current limitation in this repo does {{FEATURE}} address?
  Name the actual file, function, or workflow gap — not a general capability
  it's known for.
- At this project's real scale (one user, a handful of decisions per day,
  no team, no production traffic), is it genuinely necessary, or would it
  only become necessary at a scale this project doesn't have and has no
  concrete plan to reach?
- What would have to be true about this project for the answer above to
  flip from "not yet" to "yes"? State the actual trigger condition.
- Verdict — pick exactly one:
  - Justified now
  - Justified later, once [trigger condition]
  - Not justified — [name the anti-pattern this would be: resume padding /
    golden hammer / premature scaling / other]

## 2. HOW — only if the verdict above is "Justified now"
- Where would this live in the repo (new module, new directory, extension
  of an existing file)?
- What's the smallest version that actually resolves the limitation named
  in WHY — explicitly, what are you NOT building, to keep this from
  growing past the justified scope?
- What existing code, tests, or CI does it touch?
- How would you verify it actually works, and separately, how would you
  verify it was worth adding (what number or behavior changes)?
- Rough effort, in hours.

## Output format
Respond in Nygard ADR format:
- Title
- Status: Proposed
- Context
- Decision
- Consequences (include what this makes harder, not only what it enables)

so the response can be pasted directly into a new
docs/adr/000N-{{feature-slug}}.md file.
```
