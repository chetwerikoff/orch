# Repository publishing policy

`orch` tracks its development pipeline, reusable tooling, prompts, policy, and
active documentation. Machine configuration, credentials, and generated runtime
state stay outside the repository. [AGENTS.md](../AGENTS.md) owns authority and
universal rules; this document owns publishing, scope, and verification details.

## Tracked content and privacy

Do not commit:

- credentials, tokens, certificates, private keys, or secret-bearing `.env` files;
- user-machine or operator-owned concrete runtime configuration;
- generated runtime, review, session, queue, cache, database, or worktree state;
- unrelated clones, worktrees, scratch directories, or logs;
- patched or vendor-modified upstream source;
- compatibility aliases or copied implementations of a removed runtime;
- personal or third-party private data not explicitly authorized by the task.

The repository `.gitignore` is a developer aid, not permission to publish content.
Shared instructions take values from the selected project; project-only rules
belong in that project's policy. Keep active runbooks limited to supported
behavior; Git history is the home for obsolete commands and layouts.

## Task and scope authority

For Issue work, the published GitHub Issue is the live specification and queue
entry. Its [scope and non-goals](issue-template.md) define the allowed work.
Implementation PRs link their source Issue near the top with `Closes #N`,
`Fixes #N`, or `Resolves #N`. Drafts and historical artifacts do not replace the
live Issue, current PR head, or current repository state.

Direct instructions retain the precedence and scope described in
[blocker philosophy](blocker-philosophy.md).

## Plan-first execution

Before edits, inspect the live task, current default branch, PR head, open review
threads, and CI where applicable. Write the shortest workable plan for the task,
then execute it. Recheck evidence after a failure and take a legitimate available
route; report exact errors and remaining uncertainty. An unavailable check never
means the code passed.

## Scope discipline

- Compare the complete live task with actual changed paths, normalized relative
  to the repository root.
- Keep changes narrow; broad path patterns do not justify unrelated edits.
- Inspect complete status and diff before every commit and preserve other work.
- On a scope mismatch, fix the artifact or diff rather than widening scope merely
  to silence a check.
- Do not track a second task queue or specification alongside the live Issue.

## Build the minimum

Build the smallest implementation that satisfies acceptance criteria. Avoid
unrequested abstraction unless a public boundary, cross-platform contract,
generated-drift prevention, risky-seam testability, or upgrade safety requires it.
Validation, security, data-loss prevention, identity checks, and required tests
are not optional simplifications.

Runtime identity and native execution rules are owned by
[AGENTS.md](../AGENTS.md#runtime-and-command-boundaries); no extra runtime
implementation or fallback is implied by a documentation or tooling task.

## Local verification and delivery

Run the task's listed checks and affected tests before handoff using the selected
project's declared runtime and commands. Do not import another repository's
verifier inventory as a prerequisite. Optional local hooks do not replace CI.
Current-head required checks and applicable review results matter; previous-head
success does not prove the current head.

For text-only work, use the [Issue template's smoke convention](issue-template.md)
and verify the task's textual acceptance criteria. Documentation changes do not
authorize runtime effects, secrets, or implementation work outside scope.

The [execution flow](flow.md) owns CI, smoke, review, worker completion, authorized
merge, adoption, and cleanup. Branch protection should require PRs and required
current-head checks and restrict direct pushes; it does not create a second
transition authority.

## Truthful history

Do not rewrite Issue, PR, review, or CI history to disguise a failure. Do not claim
a check ran or an action completed without final readback facts. Report GitHub
publication and local activation separately when they differ.
