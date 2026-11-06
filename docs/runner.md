# Runner

The runner implements [the execution flow](flow.md). GitHub is workflow state;
OpenCode V2 owns sessions and queued prompts. There is no runner state file.

## Requirements

- Node **24** (native TypeScript), `git`, authenticated `gh`, `opencode2`,
  Claude Code (`claude`, for T3 reviews), and the running Orca desktop/CLI.
- A local operator checkout on `main` in this repository's git worktree list.
  Run commands from a checkout of this repository. Worker branches are `orch/<N>`.
- `ORCA_CLI_COMMAND`: the exact executable for the selected Orca installation.
  Never set it to bare `orca` (on Linux that may be the screen reader).
- `ORCH_ORCHESTRATOR_SESSION`: the exact existing V2 orchestrator session ID.
  Notices queue there; the runner never answers a form or permission request.
- GitHub labels `orch:active` and `orch:escalated` must exist. Create them once
  with `gh label create orch:active` and `gh label create orch:escalated` if needed.
  The GitHub credential needs Issues/PR/comment/status writes, and `workflow`
  scope when publishing the required CI workflow.

Use the installed V2 API contract for integration details, without web access:

```sh
opencode2 api GET /openapi.json | jq '.paths["/api/session"].post'
```

Read-only GET probes can check response shapes. Keep session creation, prompting,
and deletion in fake-backed tests until a live smoke run is explicitly authorized.

## Commands

```sh
node scripts/runner/cli.ts start 12
node scripts/runner/cli.ts tick --dry-run
node --test scripts/runner
```

`start <N>` admits an open Issue: it creates the Orca worktree if absent, verifies
the exact `orch/<N>` branch, creates the worker session, queues the Issue prompt,
opens a visible `opencode2 --session <id>` terminal, removes `orch:escalated`, and
adds `orch:active`. An existing worktree is reused. Each explicit repeat creates
the next worker session (`ses_orch_<N>`, then `ses_orch_<N>_2`, etc.), so it also
recovers an interrupted start or resumes an escalated worker. It is not an
automatic restart command: the orchestrator decides whether to call it.

`tick --dry-run` collects facts and prints each refreshed Issue's stage, its one
proposed action, and the total GitHub REST calls. It does not launch agents, send
prompts, post comments/statuses, edit labels, fetch refs, or change a checkout.
Errors remain failures. A non-refresh minute prints that no refresh is due; it
does not invent a cached stage.

For effectful ticks use the same systemd unit as the timer, including on demand:

```sh
systemctl --user start orch-runner.service
journalctl --user -u orch-runner.service -n 100 --no-pager
```

Direct `node scripts/runner/cli.ts tick` is the unit's entrypoint, not a second
concurrent scheduler. Run it manually only with the timer stopped and no active
unit. systemd serializes timer and on-demand starts of the **same** oneshot unit;
reviewers finish inside that invocation. There is no additional lock or lease.

## Scheduling

Create `~/.config/systemd/user/orch-runner.service`, replacing the example paths
and session ID with current native values. Use absolute executable paths in
`PATH`/`ExecStart` as needed; systemd does not load interactive shell dotfiles.
Keep credentials out of the unit; use the selected tools' normal authentication.

```ini
[Unit]
Description=orch runner tick

[Service]
Type=oneshot
WorkingDirectory=/absolute/path/to/orch
Environment=PATH=/absolute/path/to/tools:/usr/local/bin:/usr/bin:/bin
Environment=ORCA_CLI_COMMAND=/absolute/path/to/orca-cli
Environment=ORCH_ORCHESTRATOR_SESSION=ses_current_orchestrator
ExecStart=/absolute/path/to/node scripts/runner/cli.ts tick
TimeoutStartSec=infinity
```

Create `~/.config/systemd/user/orch-runner.timer`:

```ini
[Unit]
Description=Run orch every minute

[Timer]
OnCalendar=*-*-* *:*:00
AccuracySec=1s
Unit=orch-runner.service

[Install]
WantedBy=timers.target
```

```sh
systemctl --user daemon-reload
systemctl --user enable --now orch-runner.timer
```

Every tick reads local git and V2 facts for all local worker branches. On minutes
divisible by five it lists labelled Issues and refreshes their GitHub facts.
Other minutes refresh only workers that became idle less than two minutes ago,
or have an unnoticed pending form/permission. Notice IDs are checked in both
the orchestrator's messages and inbox. The latest worker suffix wins; old worker
sessions are not supervised or restarted.

For three Issues with a PR, the ordinary first-page read cost is 16 per scheduled
tick (one Issue list, then PR discovery/detail, comments, checks, and statuses
per Issue), or 96 in 30 minutes. Pagination and new idle/question reasons add
calls. Measure a live dry-run series using the printed counts; `gh api rate_limit`
before/after also works when other consumers are not using the shared token.

## Outputs and recovery

Review and smoke formats are owned by [flow.md](flow.md#review). Reviewer runs
have read-only file tools, receive the exact Issue/PR/CI/comment context and
`git diff origin/main...<head>`, and must finish with `orch-review-complete`.
Missing completion, failed execution, or unusable verdict is an outage: no review
comment is posted, and a later tick retries. Review comments bind the runner's
SHA, not anything the reviewer printed. A lost status write is repaired from the
posted comment without rerunning the reviewer. A dirty or wrong-head checkout
fails rather than resetting the worker's work.

The runner queues work with head-keyed message IDs and checks both messages and
inbox before sending. Pending questions take priority over work. Merge sessions
are `ses_orch_<N>_merge_<sha7>` in the operator checkout. Existing active merge
sessions are left alone; inactive unmerged ones escalate rather than restart.
An escalation adds `orch:escalated`, posts the reason and next decision owner,
then removes `orch:active`. Inspect the Issue and session, resolve the cause,
and let the orchestrator explicitly call `start <N>` when appropriate.

No merge, cleanup, timer installation, or operator-checkout adoption happens
merely by installing these files. The merge agent owns adoption and cleanup.

Worker inability is not a runner-detected escalation. A worker asks or stops;
the runner sends the corresponding notice. The orchestrator decides whether to
remove `orch:active`, add `orch:escalated`, and post `orch-escalation`.
