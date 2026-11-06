import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Runner, parseWorktrees } from './runtime.ts';
import type { Run } from './runtime.ts';
import { parseComments, ciState, reviewerResult, tierOf } from './github.ts';
import { decide } from './decide.ts';
import { facts } from './decide.test.ts';

const issueBody = '## Goal\nTest\n```complexity-tier\ntier: T2\nbecause: test\n```';
const sha = 'a'.repeat(40);
const main = '/repo/main', worker = '/repo/worker';
const epoch = 30 * 60_000;
function fixture(count = 1) {
  const calls: { file: string; args: string[]; cwd?: string; input?: string }[] = [];
  const output: string[] = [];
  const messages = new Map<string, Set<string>>();
  const inboxes = new Map<string, any[]>();
  const issues = new Map<number, any>();
  const sessions: any[] = [{ id: 'ses_orchestrator', location: { directory: main }, time: { created: epoch } }];
  const prs = new Map<number, any>();
  const comments = new Map<number, any[]>();
  const statuses = new Map<string, any[]>();
  const live: Record<string, any> = {};
  const forms = new Map<string, any[]>(), permissions = new Map<string, any[]>();
  const trees = [{ path: main, branch: 'main', head: 'b'.repeat(40) }];
  for (let n = 1; n <= count; n++) {
    issues.set(n, { number: n, state: 'open', body: issueBody, labels: [{ name: 'orch:active' }] });
    trees.push({ path: `${worker}${n}`, branch: `orch/${n}`, head: sha });
    sessions.push({ id: `ses_orch_${n}`, location: { directory: `${worker}${n}` }, time: { created: epoch } });
    live[`ses_orch_${n}`] = { type: 'running' };
    prs.set(n, { number: n + 100, head: { sha }, draft: false, merged_at: null, state: 'open', mergeable: true, mergeable_state: 'clean' });
  }
  const fail = (tag: string) => { throw Object.assign(new Error(tag), { stdout: JSON.stringify({ _tag: tag }) }); };
  const run: Run = async (file, args, cwd, input) => {
    calls.push({ file, args, cwd, input });
    const json = (value: any) => JSON.stringify(value);
    if (file === 'git') {
      if (args[0] === 'worktree') return trees.map(t => `worktree ${t.path}\nHEAD ${t.head}\nbranch refs/heads/${t.branch}\n`).join('\n');
      if (args[0] === 'show') return `${sha} ${epoch / 1000}`;
      if (args[0] === 'rev-parse') return sha;
      if (args[0] === 'status') return '';
      if (args[0] === 'diff') return 'diff --git a/test b/test\n+hello';
      if (args[0] === 'fetch') return '';
    }
    if (file === 'opencode2') {
      if (args[0] === '--version') return 'v2.2.5';
      if (args[0] === 'run') return 'NO_FINDINGS\norch-review-complete\n';
      const op = args[1];
      const params = Object.fromEntries(args.flatMap((a, i) => a === '--param' ? [args[i + 1].split(/=(.*)/s).slice(0, 2)] : []));
      const body = args.includes('--data') ? JSON.parse(args[args.indexOf('--data') + 1]) : undefined;
      if (op === 'session.active') return json({ data: live });
      if (op === 'session.list') return json({ data: sessions.filter(s => s.location.directory === params.directory), cursor: {} });
      if (op === 'session.create') {
        const s = { ...body, id: body.id ?? 'ses_reviewer', time: { created: epoch } };
        sessions.push(s); return json({ data: s });
      }
      if (op === 'session.get') return json({ data: sessions.find(s => s.id === params.sessionID) ?? fail('SessionNotFoundError') });
      if (op === 'session.message.get') return messages.get(params.sessionID)?.has(params.messageID) ? json({ data: { id: params.messageID } }) : fail('MessageNotFoundError');
      if (op === 'session.inbox.list') return json({ data: inboxes.get(params.sessionID) ?? [] });
      if (op === 'session.message.list') return json({ data: [...(messages.get(params.sessionID) ?? [])].map(id => ({ id })), cursor: {} });
      if (op === 'session.form.list') return json({ data: forms.get(params.sessionID) ?? [] });
      if (op === 'session.permission.list') return json({ data: permissions.get(params.sessionID) ?? [] });
      if (op === 'session.prompt') {
        const inbox = inboxes.get(params.sessionID) ?? []; inbox.push(body); inboxes.set(params.sessionID, inbox);
        return json({ data: body });
      }
    }
    if (file === 'claude') return 'NO_FINDINGS\norch-review-complete\n';
    if (file === '/orca-cli') {
      if (args[0] === '--version') return 'orca test';
      if (args[0] === 'worktree' && args[1] === 'create') {
        const n = Number(args[args.indexOf('--issue') + 1]);
        trees.push({ path: `${worker}${n}`, branch: `orch/${n}`, head: sha });
        return json({ ok: true, result: {} });
      }
      if (args[0] === 'worktree') return json({ ok: true, result: { worktree: { id: 'repo::path', identity: { key: 'wt2:local:exact' } } } });
      if (args[0] === 'terminal') return json({ ok: true });
    }
    if (file === 'gh') {
      const method = args[args.indexOf('--method') + 1];
      const url = new URL(args[args.indexOf('--method') + 2], 'https://api.github.com/');
      const path = url.pathname.replace('/repos/chetwerikoff/orch/', '');
      const fields: Record<string, any> = {};
      for (let i = 0; i < args.length; i++) if (args[i] === '-f') {
        const [k, v] = args[i + 1].split(/=(.*)/s);
        if (k.endsWith('[]')) (fields[k.slice(0, -2)] ??= []).push(v); else fields[k] = v;
      }
      if (path === 'issues') return json([...issues.values()].filter(i => i.labels.some((l: any) => l.name === 'orch:active')));
      if (/^issues\/\d+$/.test(path)) return json(issues.get(Number(path.split('/')[1])));
      if (path === 'pulls') return json([prs.get(Number(url.searchParams.get('head')!.split('/').at(-1)))].filter(Boolean));
      if (/^pulls\/\d+$/.test(path)) return json([...prs.values()].find(p => p.number === Number(path.split('/')[1])));
      if (path.endsWith('/comments')) {
        const n = Number(path.split('/')[1]); const list = comments.get(n) ?? [];
        if (method === 'POST') { list.push(fields); comments.set(n, list); return json(fields); }
        return json(list);
      }
      if (path.endsWith('/check-runs')) return json({ check_runs: [{ id: 1, app: { id: 1 }, name: 'test', status: 'completed', conclusion: 'success' }] });
      if (path.endsWith('/statuses')) return json(statuses.get(path.split('/')[1]) ?? []);
      if (path.startsWith('statuses/')) {
        const list = statuses.get(path.split('/')[1]) ?? []; list.unshift(fields); statuses.set(path.split('/')[1], list); return json(fields);
      }
      if (path.includes('/labels')) {
        const n = Number(path.split('/')[1]); const i = issues.get(n);
        if (method === 'DELETE') i.labels = i.labels.filter((l: any) => l.name !== decodeURIComponent(path.split('/')[3]));
        else for (const name of fields.labels) if (!i.labels.some((l: any) => l.name === name)) i.labels.push({ name });
        return json(i.labels);
      }
    }
    throw new Error(`Unhandled fake command ${file} ${args.join(' ')}`);
  };
  const runner = new Runner(main, { ORCA_CLI_COMMAND: '/orca-cli', ORCH_ORCHESTRATOR_SESSION: 'ses_orchestrator' }, run, line => output.push(line));
  return { runner, calls, output, messages, inboxes, issues, sessions, prs, comments, statuses, live, trees, forms, permissions };
}

test('comment protocol binds runner SHA; malformed/truncated reviewer output is outage', () => {
  const body = `orch-review\nhead-sha: ${sha}\nreviewer: gpt\nround: 1\nresult: NO_FINDINGS\nNO_FINDINGS`;
  const parsed = parseComments([{ body }, { body: body.replace('orch-review', 'quoted orch-review') }, { body: 'orch-smoke-report\nhead-sha: abc\nresult: PASS\nscenarios:\n  - action: a | expected: b | observed: b | outcome: pass' }]);
  assert.equal(parsed.reviews.length, 1); assert.equal(parsed.reviews[0].head, sha); assert.equal(parsed.smokes.length, 1);
  for (const output of ['', 'NO_FINDINGS', 'NO_FINDINGS\norch-review-com', 'coverage missing\norch-review-complete']) assert.equal(reviewerResult(output), undefined);
  assert.equal(reviewerResult('NO_FINDINGS\norch-review-complete')?.result, 'NO_FINDINGS');
  assert.equal(reviewerResult('P1 evidence: abc recommendation: fix\norch-review-complete')?.result, 'FINDINGS');
  assert.equal(tierOf(issueBody), 'T2'); assert.throws(() => tierOf('missing'));
});
test('CI excludes review statuses, binds newest check run, waits for actual CI', () => {
  const run = { id: 1, name: 'test', status: 'completed', conclusion: 'failure' };
  assert.equal(ciState([], []), 'pending');
  assert.equal(ciState([{ ...run, conclusion: 'success' }], [{ context: 'orch-review/gpt', state: 'failure' }]), 'success');
  assert.equal(ciState([run, { ...run, id: 2, conclusion: 'success' }], []), 'success');
  assert.equal(ciState([{ ...run, status: 'queued' }], []), 'pending');
  assert.equal(ciState([], [{ context: 'external', state: 'error' }]), 'failure');
});
test('dry-run tick makes reads only and reports one stage per active Issue', async () => {
  const f = fixture(); await f.runner.tick(true, epoch);
  assert.match(f.output.join('\n'), /#1 REVIEW/);
  assert.match(f.output.join('\n'), /GitHub REST calls: 6/);
  assert.ok(f.calls.every(c => c.file === 'git' || (c.file === 'gh' ? c.args.includes('GET') : !['session.prompt', 'session.create', 'run'].includes(c.args[1]))));
  f.calls.length = 0; await f.runner.tick(true, epoch + 60_000);
  assert.equal(f.calls.filter(c => c.file === 'gh').length, 0);
});
test('no PR gives WORKING and stopped notice is sent once in inbox and after consumption', async () => {
  const f = fixture(); f.prs.clear(); delete f.live.ses_orch_1; f.sessions[1].time.idle = epoch - 5_000;
  await f.runner.tick(false, epoch);
  assert.match(f.output.join('\n'), /#1 WORKING/);
  assert.equal(f.inboxes.get('ses_orchestrator')!.length, 1);
  await f.runner.tick(false, epoch);
  assert.equal(f.inboxes.get('ses_orchestrator')!.length, 1);
  const id = f.inboxes.get('ses_orchestrator')![0].id;
  f.inboxes.set('ses_orchestrator', []); f.messages.set('ses_orchestrator', new Set([id]));
  await f.runner.tick(false, epoch);
  assert.equal(f.inboxes.get('ses_orchestrator')!.length, 0);
});
test('review publishes once, current SHA not reviewer text; next tick only requests smoke', async () => {
  const f = fixture(); await f.runner.tick(false, epoch);
  assert.equal(f.comments.get(101)!.length, 1);
  assert.match(f.comments.get(101)![0].body, new RegExp(`head-sha: ${sha}`));
  const permissions = JSON.parse(f.calls.find(c => c.file === 'opencode2' && c.args[1] === 'session.create')!.args.at(-1)!).permissions;
  assert.equal(permissions[0].effect, 'deny');
  await f.runner.tick(false, epoch);
  assert.equal(f.comments.get(101)!.length, 1); assert.equal(f.inboxes.get('ses_orch_1')!.length, 1);
  await f.runner.tick(false, epoch);
  assert.equal(f.inboxes.get('ses_orch_1')!.length, 1);
});
test('READY twice starts exactly one deterministic merge session and exact-identity terminal', async () => {
  const f = fixture();
  f.comments.set(101, [{ body: `orch-smoke-report\nhead-sha: ${sha}\nresult: PASS\nscenarios:\n  - pass` }]);
  await f.runner.tick(false, epoch);
  f.live[`ses_orch_1_merge_${sha.slice(0, 7)}`] = { type: 'running' };
  await f.runner.tick(false, epoch);
  assert.equal(f.calls.filter(c => c.file === 'opencode2' && c.args[1] === 'session.create').length, 1);
  assert.equal(f.calls.filter(c => c.file === '/orca-cli' && c.args[0] === 'terminal').length, 1);
  assert.ok(f.calls.find(c => c.file === '/orca-cli' && c.args[0] === 'terminal')!.args.includes('identity:wt2:local:exact'));
  delete f.live[`ses_orch_1_merge_${sha.slice(0, 7)}`];
  await f.runner.tick(false, epoch);
  assert.ok(f.issues.get(1).labels.some((l: any) => l.name === 'orch:escalated'));
  assert.ok(!f.issues.get(1).labels.some((l: any) => l.name === 'orch:active'));
});
test('start reuses exact branch, advances worker suffix, and resumes escalation', async () => {
  const f = fixture(); f.issues.get(1).labels = [{ name: 'orch:escalated' }];
  await f.runner.start(1); await f.runner.start(1);
  assert.ok(f.sessions.some(s => s.id === 'ses_orch_1_2')); assert.ok(f.sessions.some(s => s.id === 'ses_orch_1_3'));
  assert.equal(f.calls.filter(c => c.file === '/orca-cli' && c.args[1] === 'create' && c.args[0] === 'worktree').length, 0);
  assert.deepEqual(f.issues.get(1).labels, [{ name: 'orch:active' }]);
  assert.match(f.inboxes.get('ses_orch_1_2')![0].text, /PR comments and findings/);
});
test('start new branch and start after worktree-only crash both use base worker ID', async () => {
  for (const exists of [true, false]) {
    const f = fixture(); f.sessions.splice(1); if (!exists) f.trees.splice(1);
    await f.runner.start(1);
    assert.ok(f.sessions.some(s => s.id === 'ses_orch_1'));
    assert.equal(f.calls.filter(c => c.file === '/orca-cli' && c.args[0] === 'worktree' && c.args[1] === 'create').length, exists ? 0 : 1);
  }
});
test('three-Issue 30-minute dry-run schedule stays within 100 GitHub calls', async () => {
  const f = fixture(3);
  for (let minute = 0; minute < 30; minute++) await f.runner.tick(true, epoch + minute * 60_000);
  const total = f.output.filter(s => s.startsWith('GitHub REST calls:')).reduce((n, s) => n + Number(s.split(': ')[1]), 0);
  assert.equal(total, 96);
  assert.ok(total <= 100);
});
test('missing destination session and unexpected API failures do not become false dedupe misses', async () => {
  const f = fixture();
  await assert.rejects(() => f.runner.prompt(undefined, 'msg_test', 'text'), /Missing destination/);
  f.runner.run = async () => { throw Object.assign(new Error('bad'), { stdout: '{"_tag":"SessionNotFoundError"}' }); };
  await assert.rejects(() => f.runner.hasMessage('ses_missing', 'msg_test'), /bad/);
});
test('new form or permission refreshes immediately, uses latest worker, then stops GitHub reads', async () => {
  const f = fixture();
  f.sessions.push({ id: 'ses_orch_1_2', location: { directory: `${worker}1` }, time: { created: epoch } });
  f.live.ses_orch_1_2 = { type: 'running' };
  f.forms.set('ses_orch_1', [{ id: 'old_form', title: 'do not supervise', fields: [] }]);
  f.forms.set('ses_orch_1_2', [{ id: 'new_form', title: 'which option?', fields: [] }]);
  await f.runner.tick(false, epoch + 60_000);
  assert.match(f.inboxes.get('ses_orchestrator')![0].text, /asks new_form/);
  assert.doesNotMatch(f.inboxes.get('ses_orchestrator')![0].text, /old_form/);
  await f.runner.tick(false, epoch + 60_000);
  assert.equal(f.runner.calls, 0);
  f.permissions.set('ses_orch_1_2', [{ id: 'permission_1', action: 'shell', resources: ['git push'], message: 'approve?' }]);
  await f.runner.tick(false, epoch + 60_000);
  assert.match(f.inboxes.get('ses_orchestrator')![1].text, /shell.*git push.*approve/);
  await f.runner.tick(false, epoch + 60_000);
  assert.equal(f.runner.calls, 0); assert.equal(f.inboxes.get('ses_orchestrator')!.length, 2);
});
test('reviewer outage retries without comments or consumed rounds', async () => {
  const f = fixture(); const run = f.runner.run;
  f.runner.run = async (file, args, cwd, input) => file === 'opencode2' && args[0] === 'run' ? 'truncated review' : run(file, args, cwd, input);
  await f.runner.tick(false, epoch); await f.runner.tick(false, epoch);
  assert.equal(f.comments.get(101), undefined); assert.equal(f.statuses.size, 0);
  assert.equal(f.calls.filter(c => c.file === 'opencode2' && c.args[1] === 'session.create').length, 2);
});
test('relaunch preserves smoke-start history from the previous worker', async () => {
  const f = fixture();
  f.issues.get(1).body = issueBody.replace('tier: T2', 'tier: T3');
  f.sessions.push({ id: 'ses_orch_1_2', location: { directory: `${worker}1` }, time: { created: epoch } });
  f.live.ses_orch_1_2 = { type: 'running' };
  f.messages.set('ses_orch_1', new Set(['msg_orch_1_smoke_oldhead']));
  await f.runner.tick(true, epoch);
  assert.match(f.output.join('\n'), /#1 SMOKE/);
});
test('posted comment survives failed status write and next tick repairs without another review', async () => {
  const f = fixture(); const run = f.runner.run; let failed = false;
  f.runner.run = async (file, args, cwd, input) => {
    if (!failed && file === 'gh' && args.includes(`repos/chetwerikoff/orch/statuses/${sha}`)) { failed = true; throw new Error('status write unavailable'); }
    return run(file, args, cwd, input);
  };
  await assert.rejects(() => f.runner.tick(false, epoch), /status write unavailable/);
  await f.runner.tick(false, epoch);
  assert.equal(f.comments.get(101)!.length, 1);
  assert.equal(f.calls.filter(c => c.file === 'opencode2' && c.args[0] === 'run').length, 1);
  assert.equal(f.statuses.get(sha)![0].state, 'success');
});
test('smoke request before report suppresses another review after a new head', () => {
  const f = facts({ tier: 'T3', smokeStarted: true });
  assert.equal(decide(f).stage, 'SMOKE');
});
test('worktree paths with spaces survive native porcelain parsing', () => {
  assert.equal(parseWorktrees('worktree /repo/with space\nHEAD abc\nbranch refs/heads/orch/1\n')[0].path, '/repo/with space');
});
