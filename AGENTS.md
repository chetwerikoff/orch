# AGENTS.md

`orch` is the local-agent development pipeline. It replaces the per-Issue LLM
manager of orchestrator-pack with plain scripts plus local agents. This file is
the single policy canon; the docs below own their topics.

## Principles

- **No bureaucracy.** No proof gates, receipts, attestations, or re-checks of
  another agent's verdict. A new gate, store, queue, watcher, lease, or retry
  layer needs a concrete invariant that existing state (GitHub Issue, PR, commit,
  CI, review statuses) cannot protect.
- **GitHub is the state.** No second source of truth. Scripts derive the current
  stage from live facts every time they run.
- **Prose is not state.** An agent's report never drives a transition;
  observable facts do (PR ready, CI on head, status on head).
- **Doubt goes down, not up** (see [tiering](docs/tiering.md)).

## Roles and runtimes

| Role | Runtime | Notes |
| --- | --- | --- |
| Architect / spec author | Claude Code, Opus | Writes the Issue spec and its tier. |
| Opus reviewer, lens | Claude Code, Opus | Separate fresh sessions. |
| GPT reviewer | OpenCode V2 (`opencode2`), `openai/*` model | Fresh session per review. |
| Editor | Claude Code, Opus | Fresh session; decides and applies reviewer findings. |
| Worker | OpenCode V2 (`opencode2`) | Own git worktree, visible Orca terminal. |
| Orchestrator | LLM agent | Queue and escalations only. No per-Issue supervision. |
| Runner | Script | Drives every deterministic post-worker transition. |

OpenCode V2 reads the shared `~/.config/opencode/opencode.json`. Model choice per
role is operator configuration, not policy.

## Topic owners

- Task tiers: [`docs/tiering.md`](docs/tiering.md)
- Spec review per tier: [`docs/spec-review.md`](docs/spec-review.md)
- Execution flow after the worker: [`docs/flow.md`](docs/flow.md)

## Status

Pilot. Rules change by editing the owning doc in place, one clause per fix.
