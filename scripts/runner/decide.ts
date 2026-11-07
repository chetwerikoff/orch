export type Stage = 'WORKING' | 'CI' | 'REVIEW' | 'FIXING' | 'SMOKE' | 'READY' | 'MERGED' | 'ESCALATED';
export type Session = { id: string; active: boolean; created: number; idle?: number };
export type Request = { id: string; session: string; text: string };
export type Review = { head: string; reviewer: string; round: number; result: 'FINDINGS' | 'NO_FINDINGS'; text: string };
export type Smoke = { head: string; result: 'PASS' | 'FAIL' | 'BLOCKED'; text: string };
export type Facts = {
  number: number; now: number; tier: 'T1' | 'T2' | 'T3';
  worker?: Session; workerIDs?: string[]; merge?: Session; requests: Request[];
  localHead?: string; commitTime?: number; seen: string[];
  pr?: { number: number; head: string; draft: boolean; merged: boolean; behind: boolean; conflict: boolean };
  ci: 'pending' | 'success' | 'failure'; ciFailures?: string[]; reviews: Review[]; smokes: Smoke[];
  statuses: Record<string, string>; escalated?: boolean; smokeStarted?: boolean; smokeNotApplicable?: boolean;
};
export type Action =
  | { kind: 'none' }
  | { kind: 'notify'; id: string; text: string }
  | { kind: 'prompt'; id: string; text: string }
  | { kind: 'review'; round: number; reviewers: string[] }
  | { kind: 'merge' }
  | { kind: 'finish' }
  | { kind: 'escalate'; reason: string };
export type Decision = { stage: Stage; action: Action };
const period = 20 * 60_000;
export const messageID = (n: number, kind: string, key: string | number) => `msg_orch_${n}_${kind}_${key}`;
export function notice(number: number, kind: string, key: string | number, facts: string): Extract<Action, { kind: 'notify' }> {
  return { kind: 'notify', id: messageID(number, kind, key), text: `orch-notify #${number} ${kind} ${key}\n${facts.replace(/\s*\n\s*/g, ' ')}` };
}
export type QueueIssue = { number: number; title: string; state: string; labels: { name: string }[]; pull_request?: unknown };
export function queueNotice(issues: QueueIssue[], activeCount: number, seen: string[]): Action {
  const ready = issues.filter(i => i.state === 'open' && !i.pull_request && i.labels.some(l => l.name === 'orch:ready') && !i.labels.some(l => ['orch:active', 'orch:escalated'].includes(l.name))).sort((a, b) => a.number - b.number);
  if (activeCount >= 2 || !ready.length) return { kind: 'none' };
  const n = notice(0, 'queue', `${ready.map(i => i.number).join('-')}_a${activeCount}`, ready.map(i => `#${i.number} ${i.title}`).join('; '));
  return seen.includes(n.id) ? { kind: 'none' } : n;
}

// These candidates also drive the free, local/V2-only read schedule.
export function noticeCandidates(f: Pick<Facts, 'number' | 'now' | 'requests' | 'worker' | 'localHead' | 'commitTime'>) {
  const notices: { kind: string; key: string | number; text: string }[] = [];
  for (const r of f.requests) notices.push({ kind: 'asks', key: r.id, text: `${r.session}: ${r.text}` });
  const w = f.worker;
  if (w && !w.active && w.idle !== undefined) notices.push({ kind: 'stopped', key: w.idle, text: `${w.id} idle since ${w.idle}` });
  if (w?.active && f.localHead && f.commitTime !== undefined) {
    const periods = Math.floor((f.now - Math.max(f.commitTime, w.created)) / period);
    if (periods >= 1) notices.push({ kind: 'no-progress', key: `${f.localHead}_${periods}`, text: `${w.id} active; HEAD ${f.localHead}; ${periods * 20} minutes without a new head` });
  }
  return notices.map(n => ({ ...n, id: messageID(f.number, n.kind, n.key) }));
}

export function shouldReadGitHub(f: Pick<Facts, 'number' | 'now' | 'requests' | 'worker' | 'localHead' | 'commitTime' | 'seen'>): boolean {
  if (Math.floor(f.now / 60_000) % 5 === 0) return true;
  if (f.worker?.idle !== undefined && !f.worker.active && f.now >= f.worker.idle && f.now - f.worker.idle < 120_000) return true;
  return noticeCandidates(f).some(n => n.kind === 'asks' && !f.seen.includes(n.id));
}

export function decide(f: Facts): Decision {
  const none: Action = { kind: 'none' };
  const out = (stage: Stage, action: Action = none): Decision => ({ stage, action });
  const prompt = (stage: Stage, reason: string, text: string): Decision => {
    const id = messageID(f.number, reason, f.pr!.head);
    return out(stage, f.seen.includes(id) ? none : { kind: 'prompt', id, text });
  };
  let d: Decision;
  const p = f.pr;
  const failures = (f.ciFailures ?? []).slice(0, 10).join('\n');
  if (p?.merged) return out('MERGED', { kind: 'finish' });
  if (f.escalated) return out('ESCALATED', { kind: 'finish' });
  if (!p || p.draft) {
    d = p && f.worker && !f.worker.active && f.ci !== 'pending'
      ? prompt('WORKING', 'cidone', `CI ${f.ci} on draft PR #${p.number}, head ${p.head}; fix it, or mark the PR ready when the Issue is done.${failures ? `\n${failures}` : ''}`)
      : out('WORKING');
  }
  else if (f.ci === 'failure') d = prompt('FIXING', 'ci', `Fix failing CI on PR #${p.number}, head ${p.head}; push the fix.${failures ? `\n${failures}` : ''}`);
  else if (f.ci !== 'success') d = out('CI');
  else {
    const reviewers = f.tier === 'T3' ? ['gpt', 'opus'] : ['gpt'];
    const cap = f.tier === 'T3' ? 2 : 1;
    const round = Math.max(0, ...f.reviews.map(r => r.round));
    const last = [...new Map(f.reviews.filter(r => r.round === round).map(r => [r.reviewer, r])).values()];
    const complete = reviewers.every(name => last.some(r => r.reviewer === name));
    const current = last.every(r => r.head === p.head);
    const incomplete = !complete || (last.some(r => r.head === p.head) && !current);
    const findings = last.some(r => r.result === 'FINDINGS');
    const pass = f.smokeNotApplicable || f.smokes.some(s => s.result === 'PASS');
    const failure = f.smokes.filter(s => s.result !== 'PASS');
    const latestFailure = failure.at(-1);
    // Once smoke has started, its fixes never open another review round.
    const smokeStarted = f.smokeStarted || f.smokes.length > 0;
    if (!smokeStarted && (!round || incomplete || (!current && findings && round < cap))) {
      const next = !round ? 1 : incomplete ? round : round + 1;
      const done = f.reviews.filter(r => r.round === next && r.head === p.head);
      const missing = reviewers.filter(name => !done.some(r => r.reviewer === name));
      d = out('REVIEW', { kind: 'review', round: next, reviewers: missing });
    } else if (!smokeStarted && current && findings) {
      d = prompt('FIXING', `review_${round}`, `Apply round ${round} orch-review findings on PR #${p.number} (head ${p.head}); push fixes, or decline findings with a one-line PR comment.`);
    } else if (!pass && latestFailure?.result === 'BLOCKED') {
      d = out('ESCALATED', { kind: 'escalate', reason: `Smoke blocked: ${latestFailure.text}` });
    } else if (!pass && latestFailure?.head === p.head) {
      d = failure.length >= 2
        ? out('ESCALATED', { kind: 'escalate', reason: 'Smoke failed twice; operator decision required.' })
        : prompt('FIXING', 'smoke_fix', `Fix orch-smoke-report failure on PR #${p.number}, head ${p.head}; push the fix.`);
    } else if (!pass) {
      d = prompt('SMOKE', 'smoke', `CI is green and review is complete for PR #${p.number}, head ${p.head}. Run every Issue smoke-test-plan scenario in order in this checkout; publish orch-smoke-report as docs/flow.md specifies.`);
    } else if (p.behind || p.conflict) {
      d = prompt('FIXING', 'base', `PR #${p.number} is behind main or conflicts. Update this branch from main, resolve conflicts, and push.`);
    } else if (!f.merge) d = out('READY', { kind: 'merge' });
    else if (f.merge.active) d = out('READY');
    else d = out('ESCALATED', { kind: 'escalate', reason: `Merge session ${f.merge.id} stopped but PR is not merged; orchestrator must inspect.` });
    // A posted review whose status write was interrupted needs only status repair.
    if (d.stage !== 'REVIEW' && last.some(r => r.head === p.head && f.statuses[`orch-review/${r.reviewer}`] !== (r.result === 'NO_FINDINGS' ? 'success' : 'failure'))) {
      d = out('REVIEW', { kind: 'review', round, reviewers: [] });
    }
  }
  const notices = noticeCandidates(f);
  // A pending question blocks the ordinary action even after it was noticed.
  const asks = notices.filter(n => n.kind === 'asks');
  const eligible = asks.length ? asks : notices.filter(n => n.kind === 'no-progress' || (n.kind === 'stopped' && d.action.kind === 'none' && ['WORKING', 'FIXING', 'SMOKE'].includes(d.stage)));
  const n = eligible.find(n => !f.seen.includes(n.id));
  if (n) return out(d.stage, { kind: 'notify', id: n.id, text: `orch-notify #${f.number} ${n.kind} ${n.key}\n${n.text}` });
  if (asks.length) return out(d.stage);
  return d;
}
