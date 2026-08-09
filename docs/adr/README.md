# Architecture Decision Records

Nygard-format ADRs (Title / Status / Context / Decision / Consequences) for
decisions worth a durable record of *why*, not just *what*.

**Tooling/dependency convention:** this project ships with zero runtime
dependencies in the extension itself, and a deliberately small `eval/`
toolchain (see [0001](0001-reward-shaping-and-eval-harness.md)). Any new
tool or dependency added *beyond* what's already in `eval/requirements.txt`
or `package.json` — a new library, a new service, new infrastructure —
should get its own ADR proposing it *before* it's added, not after. The ADR
should state what problem it solves that the current toolchain can't, and
why it's justified at this project's actual scale (a single-user browser
extension), not just that it's a common industry tool in general. See
0001's "Tooling justification" section for the format this is expected to
follow.

To produce that ADR, use [`TOOL_PROPOSAL_PROMPT.md`](TOOL_PROPOSAL_PROMPT.md)
— a fill-in-the-blank prompt that forces the why (is this actually needed at
this project's real scale, or only at a scale it doesn't have) to be
answered and written down before any implementation plan gets written.
