---
name: investigate-root-cause
description: Investigate, debug, or explain a failure, flaky behavior, or recurring bug. Use when the cause needs evidence, especially when a prior fix should have prevented recurrence.
---

# Investigate root cause

Read [the investigation prompt](../../../prompts/investigate-root-cause.md)
and follow it against the current repository and exact failing target.
[AGENTS.md](../../../AGENTS.md) owns authority, scope, runtime, and transport.

1. Bound the question and gather citable artifacts: current Issue, PR/head,
   failing command, logs, actual input/output shapes, and relevant source.
2. For recurrence, identify and, when safe and representative, rerun the prior
   fix's own acceptance check before proposing another patch. A passing check
   alongside reproduction points strongly toward a defective spec or fixture;
   record version skew, partial rollout, races, or unavailable checks.
3. Reproduce from evidence and separate infrastructure failure from product
   failure. Label facts and hypotheses; rank surviving hypotheses with evidence
   for and against and a concrete confirm/refute check.
4. Apply evidence-grounded 5 Whys. A log or intermediate return value is not a
   terminal cause: reach the false data assumption, contract, rule, or mechanism.
   If evidence runs out, say **root cause not established**.
5. Recommend the narrowest durable correction and representative regression
   coverage. Investigation does not expand the authorized implementation scope.
6. Check live shipped-versus-planned facts before describing remaining work.
   Report observed checks, uncertainty, immediate mitigation, and next actions.
