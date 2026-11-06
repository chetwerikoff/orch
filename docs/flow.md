# Execution flow

From a ready spec to a merged PR. There is no per-Issue LLM manager. A script (the
runner) drives every deterministic transition; LLMs act only where judgment is
needed. Agents keep no workflow memory between calls.

## Runner

- Runs every few minutes (and once on demand). Stateless: each run derives every
  active Issue's stage from GitHub facts and takes at most one next action per
  Issue.
- Results it produces (smoke) are posted as commit statuses keyed by the PR head
  SHA. Results for an older head are ignored.
- A second run, a crash, or a restart is harmless: the stage is recomputed and
  actions are keyed by head SHA.

## Stages

```
QUEUED    --orchestrator admits-->          WORKING  (worker in own worktree)
WORKING   --PR is non-draft-->              CI
CI        --red on head-->                  FIXING
CI        --green on head-->                SMOKE    (runner, clean worktree at head)
SMOKE     --fail (1st)-->                   FIXING
SMOKE     --fail (2nd)-->                   ESCALATED
SMOKE     --pass-->                         REVIEW   (PR review, status on head)
REVIEW    --clean-->                        READY
REVIEW    --findings, round <= 2-->         FIXING
REVIEW    --findings, round > 2-->          ESCALATED
FIXING    --new head pushed-->              CI
READY     --merge (see open question)-->    MERGED
any       --no head change for T hours-->   relaunch worker once, then ESCALATED
READY     --behind / conflict-->            FIXING
```

- **Done signal:** the PR leaving draft, not the worker's report.
- **Order:** CI → smoke → review, so a broken PR does not spend a review round.
- **Smoke** runs the spec's scripted smoke commands at the head SHA in a temporary
  detached worktree; exit code decides. It reruns on every new head. A separate
  agent is used only for scenarios that cannot be scripted (UI, browser).
- **Fixes:** the same worker session applies review and smoke findings. It may
  decline a finding with a one-line reason in the PR; the next review round
  judges that. If the session is dead or compacted, start a fresh worker in the
  same worktree from the Issue, the PR, and the findings.
- **Reviewer outage** is retried on the next run and does not consume a round.
- **Escalation** goes to the orchestrator and, from there, to the operator. The
  runner never tries to resolve an unusual case itself.

## Orchestrator

Picks Issues from the queue under the slot limit, starts their workers, and
handles escalations. It does not watch normal transitions.

## Deliberately not handled

Proof that a worker did what it said; checking a reviewer's verdict; multi-source
review consensus; reusing a smoke PASS across heads; heartbeats beyond one stall
timeout; label sync as a second source of truth.

## Open question

Merge on READY: the runner merges directly, or the runner hands the PR to a
separate merge agent. Operator decision pending.

## Pilot acceptance

One real Issue completes through this flow, and these cases behave as stated:
worker dies after push (runner finds the PR, no duplicate work); runner fires
twice (nothing repeats); new head after review (old statuses ignored); round cap
reached (escalation, no merge).
