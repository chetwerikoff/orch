# Spec review

The author writes the Issue spec and its tier ([tiering](tiering.md)). The author
never adjudicates review findings: authors tend to defend or over-accept their own
text. Reviewers never apply their own findings, except the lens (below).

## Per tier

| Tier | Stages (in order) |
| --- | --- |
| T1 | None. The spec goes straight to a worker. |
| T2 | GPT review → editor → lens. |
| T3 | Opus review + GPT review + third-model review (parallel, independent) → editor → lens. |

- Parallel reviewers do not see each other's output.
- The third T3 model (GLM, Grok, or similar) is on probation. Drop it if, over
  the first several T3 tasks, almost none of its findings are accepted that no
  other reviewer also found.
- There is no separate Opus reviewer in T2: the lens is the Opus pass.

## Author

Besides the spec body, the author writes a short **Decisions and non-goals**
section, one line per decision. The editor and the worker both need it.

## Reviewers

Each reviewer uses [`prompts/draft-review.md`](../prompts/draft-review.md): it looks
for contradictions, infeasibility, unnecessary machinery, and
material gaps against the live spec and repository. One output per reviewer,
findings with id, severity, evidence, and recommendation.

## Editor

A fresh Opus session. Input: the spec, all reviewer outputs, targeted repo reads.

- Every finding is a proposal, not an instruction. For each one record a
  disposition, one line of reason, and the source tag (`opus`, `gpt`, `third`,
  `lens`):
  - **accept** — real contradiction, infeasibility, contract, security, scope, or
    acceptance gap; fix it;
  - **partial** — the defect is real but the remedy is over-prescribed; fix only
    the required outcome, in the cheapest sufficient way;
  - **reject** — speculative, stylistic, disproportionate, or out of scope.
- A reject reason cites evidence the reviewer could read: a file:line, the Issue
  text, or a recorded decision. "Intentional" or "out of scope" without such
  evidence is not a reason. When the evidence exists only outside the material
  the reviewer could read, the finding goes to the operator questions instead.
  Do not add context to the spec only to satisfy a zero-context reviewer.
- Accepted and partial findings are applied to the Issue body by the editor
  directly.
- Each reviewer runs once per spec. There is no second review pass after the
  editor; the lens is the last check.
- Accepting a finding that adds machinery (gate, store, queue, watcher, lease,
  retry, persistent state) requires naming the invariant that breaks without it.
- Questions about intent or scope are not decided: they are collected for the
  operator.

## Lens

A fresh Opus session, always last, on the edited spec. Its job is the opposite of
the reviewers': **cut overengineering and prove the task is feasible as written.**

1. Contradictions.
2. Feasibility as written, checked against the live code on `main` (cite
   file:line; probe the real tool or API when the spec depends on a field or
   behaviour that may not exist).
3. Machinery: give every mechanism a verdict `keep`, `cut`, or `simplify`, with
   the cheapest sufficient alternative. A mechanism stays only with a concrete
   invariant that existing authoritative state cannot protect.
4. Material gaps (recovery, rollout, acceptance) — added only in the cheapest
   sufficient form.

The lens **applies its own results** to the Issue body: it already holds the live
code context, and handing it to another agent wastes it. When fixing an
infeasible condition needs a choice the code does not settle, the lens asks the
operator instead of guessing.

## Done

The spec is ready for a worker when the last stage of its tier has applied its
edits and no operator question is open.
