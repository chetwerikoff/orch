# First principles: ten modes for critical and costly analysis

## Purpose

Use the full framework for high-impact, high-cost, or hard-to-reverse decisions:
architecture, tooling/model choice, development-cost strategy, orchestration
redesign, scaling task queues or agents, and recurring failures. The goal is to
reconstruct the problem from its objective, assumptions, constraints, cost,
architecture, scale, and root causes rather than ask which tool is best.

Do not apply the full framework to small CLI changes, README edits, simple
logging, obvious fixes, routine tests, or decisions settled by deterministic
checks. The [five-mode framework](first_principles_5_operational_framework.md)
is the shorter option.

## How to use

For each relevant mode, answer explicitly, separate facts from assumptions, mark
unknowns, and defer implementation proposals until analysis is complete. Finish
with a decision, risks, and next actions.

Examples below are hypotheses for analysis, not requirements for new components
or a replacement workflow. [AGENTS.md](../AGENTS.md) owns policy;
[tiering](tiering.md), [spec review](spec-review.md), and [execution flow](flow.md)
own classification and review. Cost or an evocative risk word alone does not
change those rules.

## 1. The real problem

**Goal:** Avoid solving a symptom, inherited wording, or proxy instead of the
actual objective.

Ask:

- How does the user currently state the problem?
- Who supplied that framing, and why?
- What underlying outcome does the user want?
- Would perfect execution of the current wording satisfy them?
- What are three alternative framings?
- Which framing describes the real problem?

**Output:** current definition, underlying goal, inherited-framing check,
alternative framings, real problem statement.

For example, replace “How do we use a local model more cheaply?” with “How can
routine implementation use cheaper executors while expensive reasoning is
reserved for architecture and critical judgment?”

## 2. Assumption destruction

**Goal:** Find obligations that are actually habits or copied workflow.

Ask:

- What assumptions have we treated as facts?
- Which are hard constraints, conventions, habits, or legacy?
- Where did each convention originate?
- When was it reasonable, and do those conditions still hold?
- What becomes possible if it is removed?

Challenge assumptions such as: the strongest agent must write code; the whole
repository must be in context; authors should review their own work; a local
model must fully replace a cloud model; cheaper means substantially worse;
more agents necessarily mean more speed; every iteration needs costly reasoning.

**Output:** assumptions, hard constraints versus convention, origins, obsolete
assumptions, opportunities if removed.

## 3. Physics test

**Goal:** Separate impossible from difficult, expensive, slow, or unfamiliar.

Ask:

- Which constraints are technically hard?
- What is limited by current hardware or software?
- What is possible but too slow or expensive?
- What is possible but merely unconventional?
- What route would respect only real constraints?

For local inference, inspect VRAM, RAM, bandwidth, generation speed, context size,
SSD/KV-cache, quantization, concurrent model capacity, and the cost of human
waiting.

**Output:** physical, engineering, economic, and conventional constraints;
physics-first path.

## 4. Constraint removal

**Goal:** Distinguish real limits from self-imposed ones.

Ask:

- Which constraints seem important?
- What would we do if each were absent?
- Is each hard or soft?
- Could a different process, architecture, cache, test, queue arrangement, or
  executor address it?
- Which limits exist only because the current workflow is assumed?

A costly, rate-limited model need not stop all work: test whether it can focus
on architecture or validation while routine work uses cheaper capacity. This is
an alternative to evaluate, not permission to change configured roles.

**Output:** perceived constraints, hypothetical removal, hard/soft classification,
self-imposed limits, unconstrained path.

## 5. Analogy versus first principles

**Goal:** Avoid importing another system's solution without its context.

Ask:

- Whose workflow are we copying, and why does it seem right?
- Does their context match ours?
- Which constraints did they have that we do not, and vice versa?
- What would we build if current agent products did not exist?

Question assumptions that a familiar dashboard, single supervising agent,
terminal-session model, or whole-repository context must be reproduced.

**Output:** analogical thinking, copied solution, context mismatch, fundamental
problem, rebuilt solution.

## 6. Clean-sheet design

**Goal:** Design without legacy workarounds while retaining a feasible migration
path.

Ask:

- What is the system's core function in one sentence?
- What would we build today with available technology?
- Which roles need agents?
- Which tasks should never go to an LLM?
- Where should scripts or tests replace reasoning?
- Where is expensive reasoning necessary?
- How does the design differ from the current system, and why does that matter?
- How can we approach it without rewriting everything at once?

**Output:** core function, clean-sheet design, differences, their significance,
incremental upgrade path. Compare against orch's existing flow before proposing
any change to it.

## 7. Raw-materials and cost breakdown

**Goal:** Decompose development cost and identify the largest useful savings.

Include input/cached-input/output tokens, hidden reasoning/compute, iteration
count, repeated context, poor specifications, broad scope, missing tests or
stopping rules, manual monitoring, local inference delays, repair after weak
results, and errors caused by incomplete context.

Ask:

- What creates cost, and which factor is the largest multiplier?
- What can a script or local model handle?
- What requires expensive reasoning?
- Which iterations could a clearer task prevent?
- Which checks could be deterministic?

**Output:** cost components, real drivers, waste, intervention points, expected
savings.

## 8. Ten-times thought experiment

**Goal:** Identify where the approach breaks at scale.

Ask:

- What does ten times mean: tasks, savings, speed, or less manual supervision?
- Where does the current workflow break?
- What is the main bottleneck?
- What fundamentally different approach might be needed?
- Which lessons matter at today's scale?

For a queue growing from one task to fifty, examine executor cost, classification,
model policy, iteration bounds, reporting, escalation, token visibility, and
quality checks. Do not treat that list as a requirement to add subsystems; test
which constraint actually fails and what current authoritative state already
protects.

**Output:** current approach, ten-times version, breaking point, scaling
constraint, alternative approach, useful present-day lessons.

## 9. Outsider perspective

**Goal:** Recover questions that expertise has made invisible.

Ask:

- What knowledge do we assume is obvious?
- Which rules would a newcomer question?
- Which apparently naive questions might matter?
- What would someone without experience of current agent tools try?
- Which simple solutions do we dismiss automatically?
- Could any work better here?

Examples: Why should an LLM read the entire project? Could stricter specifications
or deterministic checks do more work? Why is classification delayed? Why is cost
not measured as part of the decision?

**Output:** insider knowledge and assumptions, beginner questions, naive
solutions, valuable simple approaches.

## 10. Five whys

**Goal:** Explain recurrence after a stuck agent, bad diff, unrelated edits,
expensive run, or failed tests.

Ask what happened, why it happened, why that cause arose, why the next cause
arose, why the system allowed it, and whether correcting the root cause would
prevent recurrence. Each causal step needs evidence; unknowns remain unknown.

For example, an expensive failed run may trace to excessive context and unclear
file scope. Inspect the actual task and inputs rather than assuming the answer
must be a new task validator or preflight step.

```text
Problem:
Why #1:
Why #2:
Why #3:
Why #4:
Why #5:
Root cause:
Corrective action:
```

## Final decision

After the analysis, summarize:

1. Real problem.
2. Key assumptions rejected.
3. Real hard constraints.
4. Soft or self-imposed constraints.
5. Cost drivers.
6. Clean-sheet architecture.
7. Ten-times scaling risks.
8. Root causes of current failures, where applicable.
9. Recommended decision.
10. Risks and trade-offs.
11. Implementation plan.
12. Non-goals: what not to do.

## Compact analysis prompt

```text
Act as a senior software architect and first-principles analyst for this
high-impact, high-cost, or hard-to-reverse decision.

Use: real problem; assumption destruction; physics test; constraint removal;
analogy versus first principles; clean-sheet design; cost breakdown; ten-times
thought experiment; outsider perspective; five whys when analyzing a failure.

Separate facts from assumptions, identify hard constraints versus conventions,
mark unknowns, avoid premature implementation, and reduce cost without critical
quality loss. Treat examples as hypotheses, not mandatory machinery.

Output the real problem, rejected assumptions, true constraints, cost drivers,
clean-sheet solution, scaling implications, root causes, recommended decision,
risks, implementation plan, and non-goals.
```
