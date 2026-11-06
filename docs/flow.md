# Execution flow

From a ready spec to a merged PR. There is no per-Issue LLM manager. A script (the
runner) drives every deterministic transition; LLMs act only where judgment is
needed. Agents keep no workflow memory between calls.

## Runner

- Runs every few minutes (and once on demand). Stateless: each run derives every
  active Issue's stage from GitHub facts and takes at most one next action per
  Issue.
- Review results are posted as commit statuses keyed by the PR head SHA; results
  for an older head are ignored. The smoke report is a PR comment (see
  [Smoke](#smoke)).
- A second run, a crash, or a restart is harmless: the stage is recomputed and
  actions are keyed by head SHA.

## Stages

```
QUEUED    --orchestrator admits-->              WORKING  (worker in own worktree)
WORKING   --PR is non-draft-->                  CI
CI        --red on head-->                      FIXING
CI        --green, review due-->                REVIEW   (status on head)
CI        --green, no review due-->             SMOKE    (worker, in its PR checkout)
REVIEW    --clean-->                            SMOKE
REVIEW    --findings, round < cap-->            FIXING
REVIEW    --findings, round = cap-->            FIXING (then CI, then SMOKE; no new round)
REVIEW    --worker cannot fix-->                ESCALATED
SMOKE     --same-PR PASS exists-->              READY    (CI green on current head)
SMOKE     --fail (1st)-->                       FIXING
SMOKE     --fail (2nd)-->                       ESCALATED
FIXING    --new head pushed-->                  CI
READY     --runner starts merge agent-->        MERGED
READY     --behind / conflict-->                FIXING
any       --no head change for T hours-->       relaunch worker once, then ESCALATED
```

- **Done signal:** the PR leaving draft, not the worker's report.
- **Order:** CI → review → smoke. A review is due when no round has run yet, or
  the last round had findings and the tier cap is not reached. A smoke fix goes
  back through CI to smoke, not to a new review round.
- **Fixes:** the same worker session applies review and smoke findings. It may
  decline a finding with a one-line reason in the PR; the next review round
  judges that. If the session is dead or compacted, start a fresh worker in the
  same worktree from the Issue, the PR, and the findings.
- **Review rounds per tier:** T1 and T2 get 1 round, T3 gets 2. After the last
  round the worker applies the findings, CI runs on the new head, then smoke;
  there is no extra review of the fix. T1/T2 work reverts
  with `git revert` by definition, so an unreviewed fix is a bounded risk.
- **PR reviewers per tier:** T1 and T2 get the GPT reviewer; T3 gets the GPT and
  Opus reviewers in parallel, independent of each other. Both families differ from
  the default worker (GLM).
- **Merge:** on READY the runner starts a fresh merge agent. It merges the PR,
  adopts the merged `main` in the operator checkout, applies any local adoption
  steps, and removes the worker's worktree.
- **Reviewer outage** is retried on the next run and does not consume a round.
- **Escalation** goes to the orchestrator and, from there, to the operator. The
  runner never tries to resolve an unusual case itself.

## Smoke

Same model as orchestrator-pack.

- The Issue declares a `smoke-test-plan` ([template](issue-template.md)):
  ordered scenarios with `action` and `expected`, or `not-applicable` with a
  reason for text-only work.
- The **worker (PR owner)** runs every scenario in order, in its own PR checkout,
  after review is done and CI is green. No other agent repeats them.
- The worker publishes one PR comment starting with the line `orch-smoke-report`:

  ```text
  orch-smoke-report
  head-sha: <git rev-parse HEAD of the exercised checkout>
  result: PASS | FAIL | BLOCKED
  scenarios:
    - action: <exact Issue action> | expected: <exact Issue expected> | observed: <what happened> | outcome: pass|fail
  ```

  A PASS lists every declared scenario in plan order with identical
  `action | expected` text. A FAIL or BLOCKED lists the executed prefix and ends on
  the failing row. No secrets or private data in the report.
- **A same-PR PASS stays valid across later heads.** Required CI is always bound
  to the current head.

## Orchestrator

Picks Issues from the queue under the slot limit, starts their workers, and
handles escalations. It does not watch normal transitions.

## Deliberately not handled

Proof that a worker did what it said; checking a reviewer's verdict; multi-source
review consensus; heartbeats beyond one stall
timeout; label sync as a second source of truth.

## Pilot acceptance

One real Issue completes through this flow, and these cases behave as stated:
worker dies after push (runner finds the PR, no duplicate work); runner fires
twice (nothing repeats); new head after review (old statuses ignored); round cap
reached (fix applied, CI on the new head, then smoke; no extra review).
