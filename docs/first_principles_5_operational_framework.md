# First principles: five modes for regular engineering work

## Purpose and use

Use this compact framework for engineering decisions, agent task definition,
expensive runs, slow loops, workflow review, and cost reduction. The goal is to
reduce development cost without critical quality loss by assigning work to the
cheapest sufficient executor: scripts, local models, cheaper cloud models, or
reasoning models.

Skip a full analysis for tiny edits, obvious fixes, simple documentation, or work
whose scope and tests already settle the decision. For costly architectural or
strategic choices, use the [ten-mode framework](first_principles_10_critical_framework.md).
These are reasoning lenses; [AGENTS.md](../AGENTS.md), [tiering](tiering.md), and
[execution flow](flow.md) own roles, review depth, and transitions.

## 1. Real problem

**Question:** What are we actually trying to improve?

Possible goals include cost, speed, quality, autonomy, resilience to limits,
operator control, queue scale, less manual work, smaller context, and reliable
review.

Ask:

- How is the task currently stated?
- Is that the real problem or a symptom?
- What observable outcome counts as success?
- Would solving only the current wording improve the situation?
- How can the problem be stated more precisely?

```text
Real problem:
Success criteria:
Not the goal:
```

Instead of “replace the strong model with a local model,” ask how much routine
implementation can move to a cheaper executor while preserving quality through
tests, review, and the existing escalation rules.

## 2. Assumption destruction

**Question:** Which supposed facts are really habits?

List assumptions, distinguish hard constraints from convention or copied
workflow, and ask what becomes possible without them. Identify assumptions that
especially increase cost.

Common assumptions to challenge:

- The strongest model must write the code.
- An agent needs the entire project in context.
- The same agent should review its own work.
- A cheaper model necessarily produces worse quality.
- A local model must replace the cloud completely.
- Every iteration needs an expensive model.
- More agents always improve the result.

```text
Assumption:
Reality check:
Hard constraint or convention:
Action:
```

## 3. Cost breakdown

**Question:** What actually creates cost?

Include input, cached input, output, and hidden reasoning/compute; iteration
count; repeated context reads; long answers; unclear specifications; poor
acceptance criteria; missing tests; broad scope; repairing weak-agent mistakes;
operator time; and waiting for local inference.

Ask:

- What can a script do without an LLM?
- What can a local or cheaper cloud model do?
- Where is expensive reasoning actually necessary?
- Which tokens need not be sent?
- Which iterations can be prevented?
- What iteration bound and escalation conditions already apply?

```text
Main cost drivers:
Can be handled by scripts:
Can be handled by local model:
Requires expensive model:
Cost reduction actions:
```

## 4. Clean-sheet design

**Question:** How would we build the process today without legacy or habit?

Identify its core function, necessary and unnecessary steps, task classification,
tests, review, expensive judgment, and escalation. Describe the smallest workable
process and an incremental route from the current one. Evaluate alternatives
against current constraints rather than treating a sample pipeline as policy.

```text
Core function:
Clean-sheet design:
What to remove from current process:
What to add:
Upgrade path:
```

## 5. Five whys

**Question:** Why does the problem recur?

Use after a stuck agent, expensive run, failed tests, bad diff, unrelated changes,
misunderstood task, endless iteration, or quality loss after model substitution.
Separate observations from hypotheses while tracing the cause.

```text
Problem:
Why #1:
Why #2:
Why #3:
Why #4:
Why #5:
Root cause:
Corrective action:
Prevention:
```

For example, unrelated edits may trace to an unclear scope in the task. Check the
actual task and changed paths before deciding on a remedy. An omitted scope may
need a clearer Issue rather than another validator; the evidence must establish
which cause and correction apply.

## Quick application

- **Engineering decision:** real problem → assumptions → cost → clean-sheet
  design → decision and next task.
- **Failure:** describe failure → five whys → root cause → corrective task →
  relevant test or prevention.
- **Executor choice:** real problem → cost breakdown → cheapest sufficient
  executor → existing quality checks → applicable escalation rule.

Prefer deterministic scripts for mechanical work and reserve expensive reasoning
for work that needs it. Actual model assignments and review requirements remain
owned by [AGENTS.md](../AGENTS.md#roles-and-runtimes), not a second routing table.

## Compact analysis prompt

```text
Act as a senior software architect using the five-mode operational framework.
Identify the real problem, reject weak assumptions, break down cost and iteration
drivers, and propose a clean-sheet design. Use five whys when analyzing a failure.
Aim to reduce cost without critical quality loss.

Recommend the cheapest sufficient executor within current repository policy.
Identify the applicable tests, review, and escalation rules without inventing
another pipeline.

Output: real problem; assumptions to reject; cost drivers; recommended design;
executor choice; quality checks; escalation conditions; concrete next action.
```

## Main rule

Ask “What is the cheapest sufficient executor that can do this task at acceptable
risk with the required tests, review, and escalation?” rather than “Which model
is best?”
