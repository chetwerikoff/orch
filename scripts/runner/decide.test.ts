import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decide, shouldReadGitHub, messageID } from './decide.ts';
import type { Facts } from './decide.ts';

export function facts(patch: Partial<Facts> = {}): Facts {
  return { number: 4, now: 30 * 60_000, tier: 'T2', requests: [], seen: [], ci: 'success', reviews: [], smokes: [], statuses: {},
    worker: { id: 'ses_orch_4', active: true, created: 29 * 60_000 }, localHead: 'abc', commitTime: 29 * 60_000,
    pr: { number: 5, head: 'abc', draft: false, merged: false, behind: false, conflict: false }, ...patch };
}
const clean = { head: 'abc', round: 1, reviewer: 'gpt', result: 'NO_FINDINGS' as const, text: 'NO_FINDINGS' };
const reviewed = { reviews: [clean], statuses: { 'orch-review/gpt': 'success' } };
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
  assert.equal(decide(facts({ ...reviewed, tier: 'T3', reviews: [{ ...clean, head: 'old' }, { ...clean, reviewer: 'opus', head: 'old' }] })).stage, 'REVIEW');
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
test('READY merge identity, drift, merged cleanup, blocked worker', () => {
  const f = facts({ ...reviewed, smokes: [{ head: 'abc', result: 'PASS', text: 'ok' }] });
  assert.equal(decide(f).action.kind, 'merge');
  f.merge = { id: 'ses_orch_4_merge_abc', active: true, created: f.now };
  assert.equal(decide(f).action.kind, 'none');
  f.merge.active = false; assert.equal(decide(f).action.kind, 'escalate');
  f.pr!.behind = true; assert.equal(decide(f).stage, 'FIXING');
  f.pr!.behind = false; f.pr!.conflict = true; assert.equal(decide(f).stage, 'FIXING');
  f.pr!.merged = true; assert.equal(decide(f).action.kind, 'finish');
  assert.equal(decide(facts({ blocked: 'cannot fix' })).stage, 'ESCALATED');
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
