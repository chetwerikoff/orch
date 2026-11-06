---
name: direct-fix-checklist
description: Apply a directly requested fix outside the normal Issue worker flow. Use when the user authorizes the specific tracked change; preserve isolated ownership, narrow scope, verification, and PR handoff.
---

# Direct-fix checklist

[AGENTS.md](../../../AGENTS.md) and
[repository policy](../../../docs/repository_policy.md) own authority, publishing,
scope, and verification. Direct authorization covers the requested outcome, not
unrelated cleanup or an automatic merge.

1. **Resolve the task.** Confirm the exact change, repository, target branch,
   and authorization. Read any linked live Issue and current PR, review, and CI
   facts. Implementation PRs link their source Issue as required by repository
   policy; a direct documentation instruction does not require a new task store.
2. **Preserve ownership.** Inspect the current branch and complete status,
   including staged, unstaged, and untracked files. Use an isolated branch/worktree
   if the checkout is shared, dirty, or not yours. Preserve other work.
3. **Choose a current base.** Fetch the intended default branch before branching,
   unless the user assigned an existing branch/worktree. Check the declared
   runtime and supported GitHub transport before command effects.
4. **Plan and edit narrowly.** State the shortest workable plan. Edit only the
   authorized paths and outcomes. If the fix grows beyond authorization, surface
   the exact scope decision rather than broadening it to silence a check.
5. **Audit before committing.** Read complete status and staged/unstaged diffs;
   compare all pending and committed changed paths against the full task and
   intended base. A committed-tree-only comparison misses pending edits.
   Resolve stray artifacts and stage only intended files.
6. **Verify.** Run task checks and affected tests using the project's own commands.
   Do not import pack verifiers. Fix failures caused by this change; when a failure
   appears unrelated, compare the same check on a clean current base when safe.
   Report pre-existing or unavailable checks truthfully without unrelated edits.
7. **Publish and read back.** Commit and push when authorized, open the PR against
   the intended base, and verify its repository, branch, head, body, and complete
   base-to-head diff. Include the Issue link where applicable, scope, verification,
   and any actual residual or next action.
8. **Hand off.** Follow [the execution flow](../../../docs/flow.md) for current-head
   CI, smoke, review, and worker completion. Authorization to fix is not merge
   authorization; use the merge skill only for an authorized merge/adoption task.
