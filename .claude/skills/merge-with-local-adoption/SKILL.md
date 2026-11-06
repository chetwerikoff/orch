---
name: merge-with-local-adoption
description: Carry out an authorized PR merge, adopt the merged default branch in the operator checkout, apply local adoption steps, and safely remove the exact worker worktree and associated branches.
---

# Merge with local adoption

[AGENTS.md](../../../AGENTS.md) owns merge authorization and exact native identity;
[the execution flow](../../../docs/flow.md) owns readiness and runner transitions.
Workers do not merge merely because implementation is complete. Act only on a
direct user merge instruction or as the fresh merge agent started by the runner
on READY. Authorization never makes failed checks pass.

## 1. Bind the exact target

Resolve from live task, GitHub, Git, and native worktree facts:

- Repository, PR number, base/default branch, full expected PR head SHA.
- PR source repository/remote and branch ref, including fork identity.
- Operator checkout absolute path (`PRIMARY_ROOT`).
- Exact non-primary merged-PR worker worktree absolute path (`WT`), its actual
  branch/ref and full OID, and any native worktree/terminal identities needed.

Read the current Issue, PR body, full changed paths/content, review threads, CI,
and current-head statuses. Reread readiness immediately before merging. Unexpected
head/base/readiness drift returns to the runner's flow; do not silently retarget.
A short name, display label, path alone, or stale record does not authorize a
runtime effect. Stop destructive work on ambiguous targets; continue unblocked work.

## 2. Preserve the operator checkout and collect adoption steps

Read the operator checkout's current rules and complete status, including staged,
unstaged, and untracked work. Preserve all pre-existing changes; do not reset,
clean, overwrite, or stash them indiscriminately. Confirm the selected branch and
remote before updating it.

Collect local adoption requirements from the Issue, PR diff/body, migration notes,
and target-owned runbooks. Name the actual post-merge work without inventing
secrets, ports, or machine-local values. Use only the selected project's supported
commands. Keep target-specific configuration in its own policy.

## 3. Merge and read back GitHub

Use the requested supported merge strategy, otherwise the repository default.
Bind the operation to the expected head with supported expected-head protection,
for example `gh pr merge <PR> --repo <REPOSITORY> --match-head-commit <HEAD_SHA>`
plus the selected strategy when needed. Do not couple merge to an unbound branch
cleanup operation.

Read the intended PR back through supported GitHub transport. Require an actual
merged state/time and real merge commit SHA (`MERGE_SHA`) before claiming success.
Record the merged PR head and base. Never substitute the PR head for an unobserved
merge SHA. On refusal, report the exact failure and next authorized action.

## 4. Adopt locally

Fetch the intended default branch into the selected operator checkout and update
it using its safe, target-owned adoption instructions, without discarding operator
work. Use a fast-forward update when applicable; on divergence or conflicting
changes, preserve them and report the required reconciliation.

Verify in that checkout:

```bash
git -C "$PRIMARY_ROOT" merge-base --is-ancestor "$MERGE_SHA" HEAD
git -C "$PRIMARY_ROOT" status --short
git -C "$PRIMARY_ROOT" log -1 --oneline
```

A later HEAD descending from the merge is valid; equality is not required. Failed
ancestry means adoption is incomplete, even if GitHub merge succeeded.

Apply the collected local adoption steps surgically. Report manual actions and
actual activation separately. Do not claim process freshness, a restart, or a
check PASS without observing it. No additional post-merge smoke is implied; the
flow owns required head-bound checks. Unrelated diagnostics do not undo a merge
or prohibit otherwise safe cleanup.

## 5. Clean only the exact worker target

Use the supported native worktree lifecycle; for Orca-managed targets, load the
available `orca-cli` skill for current command syntax and identity handling.

1. Reread Git/native inventories and canonical absolute paths. Confirm `WT` is
   the one merged-PR worker target, not the primary checkout, current merge-agent
   checkout, or any sibling. Recheck its branch and OID against the bound target.
2. Inspect complete target status. Preserve unexpected dirty or moved work and
   report its owner/next action rather than deleting it under an old binding.
3. Stop/close only native terminals and processes bound to this exact target.
   Preserve mixed or unrelated panes. Confirm target quiescence before removal;
   unreadable process state is uncertainty, not proof of no holders.
4. Remove only `WT` through the supported lifecycle. Do not use broad path/name
   matching, bulk prune, recursive deletion, or a force fallback to override an
   ambiguous target, live holder, or permission failure.
5. Read back Git and native inventories to confirm that exact worktree is absent.
   Worktree removal alone does not prove branch cleanup.
6. Delete an associated local branch only after it is detached from every
   worktree, with its captured expected-old-OID compare-and-delete:

   ```bash
   git -C "$PRIMARY_ROOT" update-ref -d "refs/heads/$ACTUAL_BRANCH" "$ACTUAL_BRANCH_OID"
   ```

7. Read back the actual PR source remote/ref. If it remains, use only an
   authorized exact-ref/expected-OID-safe deletion route. A moved branch or CAS
   mismatch preserves the ref for its owner to reconcile. If no safe supported
   route exists, report the surviving ref and next action; never claim deletion.
8. Reread target absence, associated local/remote refs, primary status, and native
   target handles. Preserve every other worktree and unrelated operator work.

## 6. Report observed outcomes

Report separately: PR/head and real merge SHA; operator checkout HEAD and ancestry;
local adoption/activation actions and residuals; exact worker worktree removal;
and associated branch cleanup. Include actual refusals, uncertainty, and the next
allowed action/decision owner for each residual. An attempted operation is not
completion, and a successful GitHub merge is not proof of local adoption or cleanup.
