# Task tiers

The tier selects only the spec-review depth (see [spec-review](spec-review.md)).
Implementation is always checked by CI, smoke, and PR review, so a too-low tier
costs bounded rework. A too-high tier costs reviews on every task. Inflation is
the known failure; this rubric is built against it.

## Rubric

Tier = the first question answered **yes with a concrete, named fact** from the
spec or the code. Imagined or "plausible" risk is not a yes. **Doubt → lower
tier.**

- **T3** — Can a defect cause damage that `git revert` of this PR does **not**
  undo? Examples: data or state migration, a published or external contract,
  credentials or authority, an irreversible external action. Name the exact
  irreversible effect.
- **T2** — Does the spec choose between real alternatives (a design decision), or
  change an interface that another component calls? Name the decision or the
  interface.
- **T1** — everything else.

Touching CI, runtime, recovery, or review code is not by itself a yes for T3:
that code reverts like any other.

## Record

The spec carries one fence:

````
```complexity-tier
tier: T2
because: <the named fact that answered yes; empty for T1>
```
````

## Calibration

The architect looks at the tier distribution once a week. Expect roughly 10% T3.
A clearly higher share means the rubric is being misapplied; fix the rubric or
the classifier prompt, not the tasks. Nothing is blocked by this check.
