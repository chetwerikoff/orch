# Issue template

The Issue body is the worker's contract. Keep it to these sections, in this
order. Anything else belongs in acceptance criteria or nowhere.

````markdown
## Goal
<observable outcome, one or two sentences>

```complexity-tier
tier: T1 | T2 | T3
because: <named fact that answered yes; empty for T1>
```

## Decisions and non-goals
- <one line per decision or explicit non-goal>

## Scope
In: <files or directories the worker may change>
Out: <what must not change, if not obvious>

## Acceptance criteria
1. <testable statement>
2. ...

```smoke
<shell commands, one per line, run by the runner at the PR head in a clean
worktree; exit code 0 = pass>
```
````

- **Smoke** is executable: the runner runs these commands and only the exit code
  counts. For text-only changes write `not-applicable: <reason>` instead.
- A check that no stale term remains is an acceptance criterion with the exact
  `rg` command and the expected empty result, not a smoke line.
- Tier rules: [tiering](tiering.md).
