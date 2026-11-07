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

```smoke-test-plan
- action: <what the worker does, with entrypoint and environment> | expected: <observable result>
- action: ... | expected: ...
```
````

- **Smoke** scenarios describe executable behaviour; the worker runs them and
  publishes the report ([flow](flow.md#smoke)). For documentation, policy,
  prompt, or skill text only, the fence holds `not-applicable: true` and a
  one-line `reason: <text>` instead. Put entrypoint and environment inside the
  `action` text, not as separate lines.
- Smoke for runner changes runs `node scripts/runner/cli.ts tick` from the PR
  checkout with the runner unit's environment and `orch-runner.timer` stopped
  ([runner](runner.md#commands)); `orch-runner.service` runs `main`, not the PR.
- A check that no stale term remains is an acceptance criterion with the exact
  `rg` command and the expected empty result, not a smoke line.
- Tier rules: [tiering](tiering.md).
