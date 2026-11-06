# Coworker CLI delegation: recipes and rationale

The core contract lives in [AGENTS.md](../AGENTS.md#coworker-cli-delegation).
This page holds examples and rationale; the contract owns the threshold,
profiles, safe corpus boundary, reasoning exceptions, and unavailable fallback.

## PR diff recipe

For a safe diff above the delegation threshold, save it before delegating:

```bash
git diff <base-ref>...HEAD > /tmp/review.diff
coworker ask --profile code --allow-code \
  --paths /tmp/review.diff \
  --question "Summarize this PR diff for a reviewer. List changed files and behavior changes. Do not make final review judgments."
```

Inspect and scrub sensitive content before passing the file to the CLI. The
summary is a navigation aid; the primary model owns review reasoning and verdicts.

## Worked read example

An investigation needs about 900 lines across policy, configuration, and a log.
After checking that the corpus is safe and scrubbing the log:

```text
coworker ask --profile code --paths AGENTS.md <config> <scrubbed-log> --question "Extract the evidence relevant to the reported failure. Separate observations from missing information."
```

Use the extracted evidence to reason about the root cause in the primary session.
Calling a task an investigation does not make its bulk reading a reasoning step.
Appending paths after the question without `--paths` does not supply the corpus.

## Cost rationale

Below the contract's threshold, use repository search, dedicated reads, diffs,
and tests directly: CLI overhead can exceed the saving. A targeted read is useful
when only a bounded slice is needed. Above the threshold, follow the core contract;
shell chunking does not turn a bulk corpus into a smaller task.

If the CLI is missing, unavailable, rate-limited, or the corpus cannot be made
safe, continue with dedicated tools under the contract's fallback. A slow running
invocation is still running; await it rather than launching another copy.

The primary model remains responsible for scope, edits, commits, and publication.
For the broader cost lens, see the
[five-mode operational framework](first_principles_5_operational_framework.md).
