import type { Review, Smoke, Facts } from './decide.ts';

export type Comment = { body: string; user?: { login: string }; author_association?: string; id?: number };
export function parseComments(comments: Comment[]) {
  const reviews: Review[] = [], smokes: Smoke[] = [];
  for (const { body, author_association } of comments) {
    // Only GitHub's repository-authorized roles may publish workflow records.
    if (!['OWNER', 'MEMBER', 'COLLABORATOR'].includes(author_association ?? '')) continue;
    const review = /^orch-review\r?\nhead-sha: ([a-f0-9]+)\r?\nreviewer: (gpt|opus)\r?\nround: ([1-9]\d*)\r?\nresult: (FINDINGS|NO_FINDINGS)\r?\n([\s\S]+)$/.exec(body);
    if (review) reviews.push({ head: review[1], reviewer: review[2], round: Number(review[3]), result: review[4] as Review['result'], text: review[5] });
    const smoke = /^orch-smoke-report\r?\nhead-sha: ([a-f0-9]+)\r?\nresult: (PASS|FAIL|BLOCKED)\r?\nscenarios:\r?\n([\s\S]+)$/.exec(body);
    if (smoke) smokes.push({ head: smoke[1], result: smoke[2] as Smoke['result'], text: smoke[3] });
  }
  return { reviews, smokes };
}

export function ciFacts(checks: any[], statuses: any[]): Pick<Facts, 'ci' | 'ciFailures'> {
  // The runner's own review statuses must not deadlock CI after findings.
  const latest = new Map<string, any>();
  for (const s of statuses) if (!s.context.startsWith('orch-review/') && !latest.has(s.context)) latest.set(s.context, s);
  const runs = new Map<string, any>();
  for (const c of checks) {
    const key = `${c.app?.id}/${c.name}`;
    if (!runs.has(key) || runs.get(key).id < c.id) runs.set(key, c);
  }
  const states = [...latest.values()].map(s => s.state);
  for (const c of runs.values()) states.push(c.status !== 'completed' ? 'pending' : ['success', 'neutral', 'skipped'].includes(c.conclusion) ? 'success' : 'failure');
  const line = (...fields: unknown[]) => fields.map(v => String(v ?? '').replace(/[\r\n]+/g, ' ')).join(' | ');
  const ciFailures = [
    ...[...runs.values()].filter(c => c.status === 'completed' && !['success', 'neutral', 'skipped'].includes(c.conclusion)).map(c => line(c.name, c.conclusion, c.details_url)),
    ...[...latest.values()].filter(s => ['failure', 'error'].includes(s.state)).map(s => line(s.context, s.state, s.target_url)),
  ].slice(0, 10);
  const ci = states.some(s => ['failure', 'error'].includes(s)) ? 'failure'
    : states.length && states.every(s => s === 'success') ? 'success' : 'pending';
  return { ci, ciFailures };
}

export function ciState(checks: any[], statuses: any[]): Facts['ci'] {
  return ciFacts(checks, statuses).ci;
}

export function tierOf(body: string): Facts['tier'] {
  const tier = /```complexity-tier\s*\n\s*tier:\s*(T[123])\b/.exec(body)?.[1];
  if (!tier) throw new Error('Issue has no valid complexity-tier fence; orchestrator must correct the Issue.');
  return tier as Facts['tier'];
}

export function smokeNotApplicable(body: string): boolean {
  const plan = /^```smoke-test-plan[^\S\r\n]*\r?\n([\s\S]*?)^```[^\S\r\n]*\r?$/m.exec(body)?.[1];
  return plan !== undefined && /^[\t ]*not-applicable:[\t ]*true[\t ]*\r?$/m.test(plan);
}

export function reviewerResult(output: string): { result: Review['result']; text: string } | undefined {
  const end = '\norch-review-complete';
  if (!output.trimEnd().endsWith(end)) return;
  const text = output.trimEnd().slice(0, -end.length).trim();
  if (!text) return;
  if (/(?:^|\n)NO_FINDINGS\s*$/.test(text)) return { result: 'NO_FINDINGS', text };
  if (/\bP[012]\b/.test(text) && /evidence/i.test(text) && /recommendation/i.test(text)) return { result: 'FINDINGS', text };
}
