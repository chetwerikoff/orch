import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decide, shouldReadGitHub, messageID, queueNotice } from './decide.ts';
import type { Facts } from './decide.ts';

export function facts(patch: Partial<Facts> = {}): Facts {
  return { number: 4, now: 30 * 60_000, tier: 'T2', requests: [], seen: [], ci: 'success', reviews: [], smokes: [], statuses: {},
    worker: { id: 'ses_orch_4', active: true, created: 29 * 60_000 }, localHead: 'abc', commitTime: 29 * 60_000,
    pr: { number: 5, head: 'abc', draft: false, merged: false, behind: false, conflict: false }, ...patch };
}
const clean = { head: 'abc', round: 1, reviewer: 'gpt', result: 'NO_FINDINGS' as const, text: 'NO_FINDINGS' };
const reviewed = { reviews: [clean], statuses: { 'orch-review/gpt': 'success' } };
test('queue notice is pure, sorted, filtered, slot-limited and deduped by ready set and active count', () => {
  const issue = (number: number, labels = ['orch:ready'], state = 'open') => ({ number, title: `Task ${number}`, state, labels: labels.map(name => ({ name })) });
  const ready = [issue(5), issue(3), issue(8, ['orch:ready', 'orch:active']), issue(9, ['orch:ready', 'orch:escalated']), issue(10, ['orch:ready'], 'closed'), issue(11, []), { ...issue(12), pull_request: {} }];
  const n = queueNotice(ready, 1, []);
  assert.equal(n.kind, 'notify');
  if (n.kind !== 'notify') return;
  assert.equal(n.id, 'msg_orch_0_queue_3-5_a1');
  assert.equal(n.text, 'orch-notify #0 queue 3-5_a1\n#3 Task 3; #5 Task 5');
  assert.deepEqual(queueNotice(ready, 1, [n.id]), { kind: 'none' });
  assert.deepEqual(queueNotice(ready, 2, []), { kind: 'none' });
  assert.deepEqual(queueNotice([], 0, []), { kind: 'none' });
  assert.deepEqual(queueNotice(ready, 0, [n.id]), { ...n, id: 'msg_orch_0_queue_3-5_a0', text: n.text.replace('a1', 'a0') });
  assert.deepEqual(queueNotice([issue(3)], 1, [n.id]), { ...n, id: 'msg_orch_0_queue_3_a1', text: 'orch-notify #0 queue 3_a1\n#3 Task 3' });
});
test('draft CI-done is idle-only, once per head, and precedes stopped notices', () => {
  for (const ci of ['success', 'failure'] as const) {
    const f = facts({ ci, worker: { id: 'ses_orch_4', active: false, created: 0, idle: 100 } });
    f.pr!.draft = true;
    const d = decide(f);
    assert.equal(d.stage, 'WORKING'); assert.equal(d.action.kind, 'prompt');
    if (d.action.kind !== 'prompt') continue;
    assert.equal(d.action.id, 'msg_orch_4_cidone_abc');
    assert.match(d.action.text, new RegExp(`CI ${ci}.*head abc`));
    assert.match(d.action.text, /fix it, or mark the PR ready when the Issue is done/);
    f.seen.push(d.action.id);
    assert.notEqual(decide(f).action.kind, 'prompt');
    f.pr!.head = 'new'; assert.equal(decide(f).action.kind, 'prompt');
    f.ci = 'pending'; assert.notEqual(decide(f).action.kind, 'prompt');
    f.ci = ci; f.worker!.active = true; assert.equal(decide(f).action.kind, 'none');
    f.worker = undefined; assert.equal(decide(f).action.kind, 'none');
  }
});
test('draft CI-done still respects pending questions', () => {
  const f = facts({ worker: { id: 'ses_orch_4', active: false, created: 0, idle: 100 },
    requests: [{ id: 'form_1', session: 'ses_orch_4', text: 'question' }] });
  f.pr!.draft = true;
  assert.equal(decide(f).action.kind, 'notify');
  f.seen.push(messageID(4, 'asks', 'form_1'));
  assert.equal(decide(f).action.kind, 'none');
});
test('admitted worker, draft, pending and failing CI', () => {
  assert.equal(decide(facts({ pr: undefined })).stage, 'WORKING');
  const f = facts(); f.pr!.draft = true;
  assert.equal(decide(f).stage, 'WORKING');
  assert.deepEqual(decide(facts({ ci: 'pending' })), { stage: 'CI', action: { kind: 'none' } });
  const d = decide(facts({ ci: 'failure' }));
  assert.equal(d.stage, 'FIXING'); assert.equal(d.action.kind, 'prompt');
  if (d.action.kind === 'prompt') assert.equal(decide(facts({ ci: 'failure', seen: [d.action.id] })).action.kind, 'none');
});
test('review outage retries, clean advances, status repair and stale head', () => {
  assert.deepEqual(decide(facts()), decide(facts()));
  assert.deepEqual(decide(facts()).action, { kind: 'review', round: 1, reviewers: ['gpt'] });
  assert.equal(decide(facts(reviewed)).stage, 'SMOKE');
  assert.deepEqual(decide(facts({ reviews: [clean] })).action, { kind: 'review', round: 1, reviewers: [] });
  assert.equal(decide(facts({ ...reviewed, tier: 'T3', reviews: [{ ...clean, head: 'old' }, { ...clean, reviewer: 'opus', head: 'old' }] })).stage, 'SMOKE');
});
test('findings, tier caps, partial T3 round', () => {
  for (const tier of ['T1', 'T2', 'T3'] as const) {
    const cap = tier === 'T3' ? 2 : 1;
    const reviews = [{ ...clean, round: cap, result: 'FINDINGS' as const }, ...(tier === 'T3' ? [{ ...clean, round: cap, reviewer: 'opus' }] : [])];
    const f = facts({ tier, reviews, statuses: { 'orch-review/gpt': 'failure', 'orch-review/opus': 'success' } });
    assert.equal(decide(f).stage, 'FIXING');
    f.pr!.head = 'new';
    assert.equal(decide(f).stage, 'SMOKE');
  }
  assert.deepEqual(decide(facts({ tier: 'T3', ...reviewed })).action, { kind: 'review', round: 1, reviewers: ['opus'] });
  const f = facts({ tier: 'T3', reviews: [{ ...clean, head: 'old', result: 'FINDINGS' }, { ...clean, reviewer: 'opus', head: 'old' }] });
  assert.deepEqual(decide(f).action, { kind: 'review', round: 2, reviewers: ['gpt', 'opus'] });
});
test('smoke fixes bypass review, later heads reuse same-PR PASS, failures escalate', () => {
  const failed = { head: 'abc', result: 'FAIL' as const, text: 'failed' };
  assert.equal(decide(facts({ ...reviewed, smokes: [failed] })).stage, 'FIXING');
  assert.equal(decide(facts({ ...reviewed, smokes: [failed, failed] })).stage, 'ESCALATED');
  const f = facts({ ...reviewed, tier: 'T3', smokes: [failed] }); f.pr!.head = 'new';
  assert.equal(decide(f).stage, 'SMOKE');
  f.ci = 'pending'; assert.equal(decide(f).stage, 'CI');
  f.ci = 'success'; f.smokes.push({ head: 'older', result: 'PASS', text: 'ok' });
  assert.equal(decide(f).stage, 'READY');
  assert.equal(decide(facts({ ...reviewed, smokes: [{ ...failed, result: 'BLOCKED' }] })).stage, 'ESCALATED');
});
test('READY merge identity, drift and merged cleanup', () => {
  const f = facts({ ...reviewed, smokes: [{ head: 'abc', result: 'PASS', text: 'ok' }] });
  assert.equal(decide(f).action.kind, 'merge');
  f.merge = { id: 'ses_orch_4_merge_abc', active: true, created: f.now };
  assert.equal(decide(f).action.kind, 'none');
  f.merge.active = false; assert.equal(decide(f).action.kind, 'escalate');
  f.pr!.behind = true; assert.equal(decide(f).stage, 'FIXING');
  f.pr!.behind = false; f.pr!.conflict = true; assert.equal(decide(f).stage, 'FIXING');
  f.pr!.merged = true; assert.equal(decide(f).action.kind, 'finish');
});
test('worker inability is an asks/stopped notice, never a runner escalation', () => {
  const f = facts({ reviews: [{ ...clean, result: 'FINDINGS' }], statuses: { 'orch-review/gpt': 'failure' },
    worker: { id: 'ses_orch_4', active: false, created: 0, idle: 100 }, seen: [messageID(4, 'review_1', 'abc')] });
  let d = decide(f);
  assert.equal(d.stage, 'FIXING'); assert.equal(d.action.kind, 'notify');
  if (d.action.kind === 'notify') assert.match(d.action.text, /stopped 100/);
  f.requests.push({ id: 'form_cannot_fix', session: 'ses_orch_4', text: 'Cannot fix without an operator decision' });
  d = decide(f); assert.equal(d.action.kind, 'notify');
  if (d.action.kind === 'notify') { assert.match(d.action.text, /asks form_cannot_fix/); f.seen.push(d.action.id); }
  assert.equal(decide(f).action.kind, 'none');
  f.escalated = true;
  assert.deepEqual(decide(f), { stage: 'ESCALATED', action: { kind: 'finish' } });
});
test('all notices dedupe; requests precede stopped; no-progress repeats only next period', () => {
  const f = facts({ pr: undefined, worker: { id: 'ses_orch_4', active: false, created: 0, idle: 100 } });
  let d = decide(f); assert.equal(d.action.kind, 'notify');
  if (d.action.kind === 'notify') f.seen.push(d.action.id);
  assert.equal(decide(f).action.kind, 'none');
  f.requests.push({ id: 'form_1', session: 'merge', text: 'question' });
  d = decide(f); assert.equal(d.action.kind, 'notify');
  if (d.action.kind === 'notify') { assert.match(d.action.text, /asks form_1/); f.seen.push(d.action.id); }
  assert.equal(decide(f).action.kind, 'none');
  f.requests = [{ id: 'perm_1', session: 'worker', text: 'shell resources' }];
  assert.equal(decide(f).action.kind, 'notify');
  f.requests = []; f.worker!.active = true; f.worker!.created = 0; f.commitTime = 0;
  d = decide(f); assert.equal(d.action.kind, 'notify');
  if (d.action.kind === 'notify') f.seen.push(d.action.id);
  assert.equal(decide(f).action.kind, 'none');
  f.now += 20 * 60_000; assert.equal(decide(f).action.kind, 'notify');
});
test('GitHub read schedule: fifth minute, recent idle, unseen request only', () => {
  const f = facts(); assert.equal(shouldReadGitHub(f), true);
  f.now += 60_000; assert.equal(shouldReadGitHub(f), false);
  f.worker!.active = false; f.worker!.idle = f.now - 60_000;
  assert.equal(shouldReadGitHub(f), true);
  f.worker!.idle = f.now - 120_000; assert.equal(shouldReadGitHub(f), false);
  f.requests = [{ id: 'perm', session: 's', text: 'ask' }]; assert.equal(shouldReadGitHub(f), true);
  f.seen.push(messageID(4, 'asks', 'perm')); assert.equal(shouldReadGitHub(f), false);
});
test('a clean last round does not make another review due on a later head', () => {
  const f = facts({ tier: 'T3', reviews: [{ ...clean, head: 'old' }, { ...clean, reviewer: 'opus', head: 'old' }] });
  assert.equal(decide(f).stage, 'SMOKE');
  f.reviews[0].result = 'FINDINGS';
  assert.deepEqual(decide(f).action, { kind: 'review', round: 2, reviewers: ['gpt', 'opus'] });
});
test('mixed-head partial round retries missing current-head reviewer without consuming another round', () => {
  const f = facts({ tier: 'T3', reviews: [{ ...clean, head: 'old' }, { ...clean, reviewer: 'opus' }], statuses: { 'orch-review/opus': 'success' } });
  assert.deepEqual(decide(f).action, { kind: 'review', round: 1, reviewers: ['gpt'] });
  f.reviews[0].result = 'FINDINGS';
  assert.deepEqual(decide(f).action, { kind: 'review', round: 1, reviewers: ['gpt'] });
});
test('a later same-PR PASS clears a historical smoke blocker, including after a new head', () => {
  const f = facts({ ...reviewed, smokes: [
    { head: 'old', result: 'BLOCKED', text: 'environment unavailable' },
    { head: 'abc', result: 'PASS', text: 'environment restored; passed' },
  ] });
  assert.deepEqual(decide(f), { stage: 'READY', action: { kind: 'merge' } });
  f.pr!.head = 'new';
  assert.deepEqual(decide(f), { stage: 'READY', action: { kind: 'merge' } });
  f.ci = 'pending'; assert.equal(decide(f).stage, 'CI');
  f.ci = 'failure'; assert.equal(decide(f).stage, 'FIXING');
});
test('idle workers receive unsent CI, findings and smoke work before stopped supervision', () => {
  const cases = [facts({ ci: 'failure' }),
    facts({ reviews: [{ ...clean, result: 'FINDINGS' }], statuses: { 'orch-review/gpt': 'failure' } }),
    facts({ ...reviewed, smokes: [{ head: 'abc', result: 'FAIL', text: 'failed' }] }), facts(reviewed)];
  for (const f of cases) {
    f.worker = { id: 'ses_orch_4', active: false, created: 0, idle: 100 };
    const work = decide(f).action;
    assert.equal(work.kind, 'prompt');
    if (work.kind !== 'prompt') continue;
    f.requests = [{ id: 'form_waiting', session: 'ses_orch_4', text: 'question' }];
    assert.equal(decide(f).action.kind, 'notify');
    f.requests = []; f.seen.push(work.id);
    const stopped = decide(f).action;
    assert.equal(stopped.kind, 'notify');
    if (stopped.kind === 'notify') { assert.match(stopped.text, /stopped 100/); f.seen.push(stopped.id); }
    assert.equal(decide(f).action.kind, 'none');
  }
});
