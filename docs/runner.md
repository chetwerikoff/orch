# Runner

The runner implements [the execution flow](flow.md). GitHub is workflow state;
worker backends own sessions and delivery (OpenCode V2 by default, or Claude Code).
There is no runner state file.

## Requirements

- Node **24** (native TypeScript), `git`, authenticated `gh`, `opencode2`,
  Claude Code (`claude`, for Claude workers and T3 reviews), and the running Orca
  desktop/CLI.
  Claude workers also require user systemd (`systemd-run`, `systemctl`, `journalctl`).
- A local operator checkout on `main` in this repository's git worktree list.
  Run commands from a checkout of this repository. Worker branches are `orch/<N>`.
- `ORCA_CLI_COMMAND`: the exact executable for the selected Orca installation.
  Never set it to bare `orca` (on Linux that may be the screen reader).
- `ORCH_ORCHESTRATOR_SESSION`: the exact existing V2 orchestrator session ID.
  Notices queue there; the runner never answers a form or permission request.
- GitHub labels `orch:ready`, `orch:active`, and `orch:escalated` must exist. Create
  each once with `gh label create <label>` if needed.
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
node scripts/runner/cli.ts start 12 --model zai-coding-plan/glm-5.3#high
node scripts/runner/cli.ts start 12 --model anthropic/sonnet#high
node scripts/runner/cli.ts say 12 "Continue with the Issue's specified option."
node scripts/runner/cli.ts tick --dry-run
node --test scripts/runner
```

`start <N> [--model <providerID>/<modelID>[#<variant>]]` admits an open Issue:
it creates the Orca worktree with `--no-parent` if absent (never inheriting the
calling terminal's worktree lineage), verifies
the exact `orch/<N>` branch, creates the worker session, queues the Issue prompt,
opens a visible backend terminal (V2: `opencode2 --session <id>`), removes
`orch:escalated`, and adds `orch:active`. An existing worktree is reused.
Each explicit repeat creates
the next worker session (`ses_orch_<N>`, then `ses_orch_<N>_2`, etc.), so it also
recovers an interrupted start or resumes an escalated worker. It is not an
automatic restart command: the orchestrator decides whether to call it.
The default model is `openai/gpt-6.1-sol#medium`. An explicit `--model` applies to
both the first start and relaunch; without `#variant`, no variant is sent.
After a provider usage limit, the orchestrator uses
`--model zai-coding-plan/glm-5.3#high`. There is no model auto-detection or retry
change.

### Claude Code workers

An `anthropic/<model>[#<effort>]` model selects Claude Code; every other provider
uses V2. Claude starts check `claude --version` and `systemd-run --version` instead
of `opencode2 --version`. The executable is the `claude` resolved by the runner's
PATH, also used by Opus reviews. Merge agents remain V2.

Worker names share suffixes across both backends: `ses_orch_<N>`,
`ses_orch_<N>_2`, etc. Each fresh process reads the full V2 session list, then
probes Claude names from suffix 1 upward. A Claude worker exists when its transcript
exists or its unit is active (including before its first transcript write).
Probing stops at the first name belonging to neither backend; the highest suffix
from either backend wins, including V2 names beyond that gap. `start` takes the
next suffix. No worker registry or runner state file is written.

The Claude UUID is UUIDv5 of the worker name in the fixed DNS namespace
`6ba7b810-9dad-11d1-80b4-00c04fd430c8`. Its transcript is
`~/.claude/projects/<encoded-worktree>/<uuid>.jsonl`, where every character of the
absolute worktree path outside `[A-Za-z0-9]` becomes `-`. The first user entry
contains `orch-worker-model: anthropic/<model>[#<effort>]`; later processes recover
the same model and effort from that entry. Creation time is the first user entry's
timestamp (not preceding metadata); idle time is the transcript mtime.

Each prompt launches a transient unit, without waiting for the worker to finish:

```sh
systemd-run --user --unit orch-claude-<uuid> --collect --expand-environment=no --setenv=PATH --working-directory <worktree> claude -p --resume <uuid> --model <model> --effort <effort> --permission-mode bypassPermissions "<text>"
```

The first prompt uses `--session-id` instead of `--resume` when the transcript is
absent; `--effort` is omitted when unspecified. `--collect` allows a failed run's
unit to be recreated; failure stays in the journal and the worker appears stopped.
`--expand-environment=no` preserves literal `$` expressions in prompt text.
`--setenv=PATH` passes the runner's PATH rather than the user manager's PATH.
An active unit is the only lock: ordinary prompts wait for a later tick, with no
queue, and systemd rejects a second launch with the same active unit name.

Every Claude prompt starts with `orch-msg: <message-id>`. Dedup reads exact first
lines of user entries; smoke-start history checks `msg_orch_<N>_smoke_` IDs,
excluding `smoke_fix_`, across all worker suffixes just as V2 does.

Print mode has no forms. When it needs an answer, the worker ends its turn with
`orch-ask: <question>`. A line in the last assistant entry is one pending request
(its UUID is the request ID), but only while the unit is inactive. It emits an
`asks` notice and blocks ordinary prompts, including CI-done; a later user entry
ends the request. Mid-turn lines in an active unit do not count.

`say <N> "<text>"` sends to the latest worker through its backend with ID
`msg_orch_<N>_say_<epoch-ms>`. For Claude it fails while the unit is active; retry
after it stops. This is also how the orchestrator answers `orch-ask` requests.

The visible Orca terminal runs `journalctl --user -f -u orch-claude-<uuid>`.
Interrupt a hung worker with `systemctl --user stop orch-claude-<uuid>`, then send
its next step with `say`, or explicitly relaunch with `start --model anthropic/...`.
Never open interactive `claude --resume` on a worker: two processes must not
write one session.

### Tick

`tick --dry-run` collects facts and prints each refreshed Issue's stage, its one
proposed action, the queue/escalation notices it would send, and the total GitHub
REST calls. No reviewer runs, so no `review-outage` can appear. It does not launch
agents, send prompts, post comments/statuses, edit labels, fetch refs, or change a checkout.
Errors remain failures. A non-refresh minute prints that no refresh is due; it
does not invent a cached stage.

An Issue-specific failure prints `#N error: ...`, leaves other Issues unblocked,
and makes the command exit nonzero after printing its total REST call count.

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

Every tick reads local git and worker-backend facts for all local worker branches.
On minutes divisible by five it lists labelled Issues and refreshes their GitHub
facts.
Other minutes refresh only workers that became idle less than two minutes ago,
or have an unnoticed pending request (V2 form/permission or Claude `orch-ask`).
Notice IDs are checked in both the orchestrator's messages and inbox.
The latest worker suffix wins; old worker sessions are not supervised or restarted.

Before processing refreshed Issues on scheduled ticks, the runner counts open
Issues from the existing `orch:active` list. Only below the slot limit of 2
([orchestrator duty 1](../prompts/orchestrator.md#duties)) does it list open
`orch:ready` Issues. Ready candidates exclude `orch:active` and `orch:escalated`.
A merged Issue is closed by its PR, freeing its slot on that same tick. An
escalation frees its slot when `orch:active` is removed; the next scheduled read
notices the queue. An individual Issue failure cannot block queue notification.
The ordinary first-page cost adds one REST call below the slot limit, none
otherwise; there is no queue read on non-scheduled ticks.

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
comment is posted, and the next tick refreshing the Issue from GitHub retries
without consuming a round. Review comments bind the runner's
SHA, not anything the reviewer printed. A lost status write is repaired from the
posted comment without rerunning the reviewer. A dirty or wrong-head checkout
fails rather than resetting the worker's work.

Each GPT review run reads `ORCH_REVIEW_GPT_MODEL`, defaulting to
`openai/gpt-6.1-sol#medium`. After a usage-limit outage the orchestrator escalates;
the architect can set `zai-coding-plan/glm-5.3#high` in the runner environment.
There is no automatic switch. The runner still publishes the review comment and
`orch-review/gpt` status under the `gpt` slot, including for the configured fallback.

### Orchestrator notices

All notices queue into `ORCH_ORCHESTRATOR_SESSION` with delivery `queue`, ID
`msg_orch_<N>_<kind>_<key>`, and text `orch-notify #<N> <kind> <key>` followed by
one facts line. An ID already in the session's messages or inbox is skipped; no
separate dedup store is used. Existing worker notices are `asks` (request ID),
`stopped` (idle timestamp), and `no-progress` (HEAD plus 20-minute period).

- `escalated`: key = full PR head SHA; facts = stage and escalation reason.
  Queued **before** the `orch-escalation` comment or either label change. Failure
  leaves labels unchanged, so a later GitHub refresh retries the escalation.
- `queue`: Issue number **0**; key = ready Issue numbers sorted ascending and
  joined by `-`, then `_a<open active count>` (for example `3-5_a1`). Facts list
  the ready numbers and titles. Computed only on scheduled ticks as above; the
  orchestrator decides admission. There is no separate `merged` notice.
- `review-outage`: emitted inside the review run for empty, truncated, or failed
  reviewer output; key = `<reviewer>_<round>_<head sha7>`; facts = reviewer and
  error, or `unusable output`. Sent once per key, without changing review retry
  scheduling. There is no second reminder: the orchestrator inspects the cause
  and escalates when it will not clear by itself. Runner errors remain failures,
  not notices.

Protocol comments are accepted only when GitHub reports the author association
as `OWNER`, `MEMBER`, or `COLLABORATOR`; missing or other associations are ignored.
This uses metadata already returned with comments, without extra REST calls.
An unsent findings/CI/smoke prompt takes precedence over a `stopped` notice;
pending questions still take priority. A valid same-PR PASS supersedes historical
BLOCKED smoke reports, while CI remains bound to the current head.

For a draft PR whose head CI has concluded (`success` or `failure`), an inactive
worker receives a CI-done prompt: the head and result, followed by "fix it, or mark
the PR ready when the Issue is done". Its ID is
`msg_orch_<N>_cidone_<head sha>`, sent once per head (checked in messages and inbox).
It is not sent while CI is pending or the worker is active, and takes precedence
over a `stopped` notice on that tick. Pending questions still take priority.
Both this prompt and the non-draft CI-red prompt include up to 10 failure lines:
check run `name | conclusion | details_url` and commit status
`context | state | target_url`, using the existing CI reads.

The runner queues work with head-keyed message IDs and checks both messages and
inbox before sending. Pending questions take priority over work. Merge sessions
are `ses_orch_<N>_merge_<sha7>` in the operator checkout. Existing active merge
sessions are left alone; inactive unmerged ones escalate rather than restart.
An escalation first queues its notice, posts the reason and next decision owner,
adds `orch:escalated`, then removes `orch:active`. Inspect the Issue and session,
resolve the cause, and let the orchestrator explicitly call `start <N>` when appropriate.

No merge, cleanup, timer installation, or operator-checkout adoption happens
merely by installing these files. The merge agent owns adoption and cleanup.

Worker inability is not a runner-detected escalation. A worker asks or stops;
the runner sends the corresponding notice. The orchestrator decides whether to
remove `orch:active`, add `orch:escalated`, and post `orch-escalation`.
