import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ClaudeBackend, V2Backend, claudeUUID } from './backends.ts';
import type { Transcript } from './backends.ts';
import { Runner } from './runtime.ts';
import type { Run } from './runtime.ts';
import { parseStartArgs } from './start.ts';
import { decide } from './decide.ts';

const directory = '/repo/issue-1';
const name = 'ses_orch_1';
const model = { providerID: 'anthropic', id: 'sonnet', variant: 'high' };
const user = (id: string, extra = '') => ({ type: 'user', timestamp: '2026-11-07T00:00:00Z', message: { content: `orch-msg: ${id}\n${extra}` } });
const assistant = (text: string) => ({ type: 'assistant', uuid: 'question-uuid', message: { content: [{ type: 'text', text }] } });
function fixture() {
  const transcripts = new Map<string, Transcript>();
  const units = new Set<string>();
  const calls: { file: string; args: string[]; cwd?: string }[] = [];
  const v2: any[] = [];
  const body = '```complexity-tier\ntier: T2\nbecause: test\n```';
  const run: Run = async (file, args, cwd) => {
    calls.push({ file, args, cwd });
    if (file === 'systemctl') {
      if (units.has(args.at(-1)!)) return 'active\n';
      throw Object.assign(new Error('inactive'), { stdout: 'inactive\n', code: 3 });
    }
    if (args[0] === '--version') return 'test version';
    if (file === 'systemd-run') {
      const unit = args[args.indexOf('--unit') + 1];
      if (units.has(unit)) throw new Error('unit already exists');
      units.add(unit);
      return '';
    }
    if (file === 'git') {
      if (args[0] === 'worktree') return `worktree ${directory}\nHEAD abc\nbranch refs/heads/orch/1\n`;
      if (args[0] === 'show') return 'abc 1794009600';
    }
    if (file === 'opencode2') {
      const op = args[1];
      if (op === 'session.list') return JSON.stringify({ data: v2, cursor: {} });
      if (op === 'session.create') { v2.push(JSON.parse(args[args.indexOf('--data') + 1])); return '{}'; }
      if (op === 'session.message.get') throw Object.assign(new Error('missing'), { stdout: '{"_tag":"MessageNotFoundError"}' });
      if (op === 'session.inbox.list') return '{"data":[]}';
      if (op === 'session.prompt') return '{}';
      if (op === 'session.get') return JSON.stringify({ data: { id: name, time: { created: 1, idle: 2 } } });
      if (op === 'session.form.list' || op === 'session.permission.list') return '{"data":[]}';
    }
    if (file === 'gh') {
      const path = args[args.indexOf('--method') + 2];
      if (path === 'repos/chetwerikoff/orch/issues/1') return JSON.stringify({ state: 'open', body, labels: [] });
      if (path.includes('/pulls?')) return '[]';
      if (path.endsWith('/labels')) return '[]';
    }
    if (file === '/orca-cli') {
      if (args[0] === 'worktree') return '{"ok":true,"result":{"worktree":{"id":"native","identity":{"key":"exact-native-identity"}}}}';
      if (args[0] === 'terminal') return '{"ok":true}';
    }
    throw new Error(`Unexpected ${file} ${args.join(' ')}`);
  };
  const read = async (path: string) => transcripts.get(path);
  const backend = (n = name) => new ClaudeBackend(n, directory, run, read, '/home/test');
  const runtime = () => new Runner(directory, { HOME: '/home/test', ORCA_CLI_COMMAND: '/orca-cli' }, run, () => {}, read);
  const save = (entries: any[], n = name, mtime = 12345) => transcripts.set(backend(n).path, { entries, mtime });
  return { transcripts, units, calls, v2, backend, runtime, save };
}

test('Claude uses a fixed UUIDv5 and encodes every nonalphanumeric worktree character', () => {
  assert.equal(claudeUUID(name), 'f45e3966-49d1-52e9-a9da-7a8f3efec350');
  assert.notEqual(claudeUUID(name), claudeUUID(`${name}_2`));
  const b = new ClaudeBackend(name, '/repo/a.b_c d', async () => '', async () => undefined, '/home/test');
  assert.equal(b.path, `/home/test/.claude/projects/-repo-a-b-c-d/${claudeUUID(name)}.jsonl`);
});

test('Claude first delivery uses session-id, literal prompt argv and transient-unit safeguards', async () => {
  const f = fixture(), b = f.backend();
  await b.create(model);
  await b.prompt('start', 'literal $HOME and ${X}');
  const call = f.calls.find(c => c.file === 'systemd-run')!;
  assert.deepEqual(call.args, ['--user', '--unit', b.unit, '--collect', '--expand-environment=no', '--setenv=PATH', '--working-directory', directory,
    'claude', '-p', '--session-id', b.uuid, '--model', 'sonnet', '--effort', 'high', '--permission-mode', 'bypassPermissions',
    'orch-msg: start\norch-worker-model: anthropic/sonnet#high\nWhen you need an answer, end your turn with a line orch-ask: <question>.\nliteral $HOME and ${X}']);
  assert.equal(call.cwd, directory);
  assert.equal((await b.state()).active, true);
  await assert.rejects(b.prompt('second', 'do not queue'), /is active/);
  assert.equal(f.calls.filter(c => c.file === 'systemd-run').length, 1);
});

test('fresh Claude backend resumes with persisted model/effort; failed unit permits next run', async () => {
  const f = fixture();
  f.save([user('start', 'orch-worker-model: anthropic/opus#medium')]);
  const b = f.backend(); // no create call or in-memory model
  await b.prompt('next', 'continue');
  let args = f.calls.find(c => c.file === 'systemd-run')!.args;
  assert.ok(args.includes('--resume')); assert.ok(!args.includes('--session-id'));
  assert.equal(args[args.indexOf('--model') + 1], 'opus');
  assert.equal(args[args.indexOf('--effort') + 1], 'medium');
  f.units.delete(b.unit); // failed/collected run
  await b.prompt('after-failure', 'retry');
  assert.equal(f.calls.filter(c => c.file === 'systemd-run').length, 2);
  f.units.clear();
  f.save([user('start', 'orch-worker-model: anthropic/sonnet')]);
  await f.backend().prompt('no-effort', 'continue');
  args = f.calls.filter(c => c.file === 'systemd-run').at(-1)!.args;
  assert.ok(!args.includes('--effort'));
});

test('Claude dedup, smoke-start, mtime and first-user creation ignore metadata and assistant markers', async () => {
  const f = fixture(), b = f.backend();
  f.save([{ type: 'session-owner' }, { type: 'queue-operation' }, user('msg_orch_1_smoke_fix_abc'), assistant('orch-msg: fake')]);
  assert.equal(await b.hasMessage('msg_orch_1_smoke_fix_abc'), true);
  assert.equal(await b.hasMessage('fake'), false);
  assert.equal(await b.smokeStarted(1), false);
  assert.deepEqual(await b.state(), { id: name, active: false, created: Date.parse('2026-11-07T00:00:00Z'), idle: 12345 });
  f.save([user('msg_orch_1_smoke_abc')]);
  assert.equal(await b.smokeStarted(1), true);
  await b.prompt('msg_orch_1_smoke_abc', 'already delivered');
  assert.equal(f.calls.filter(c => c.file === 'systemd-run').length, 0);
  f.save([user('other', 'quoted\norch-msg: fake')]);
  assert.equal(await b.hasMessage('fake'), false);
});

test('shared suffix discovery recovers both runtimes and active Claude without a transcript', async () => {
  const f = fixture();
  f.v2.push({ id: name });
  f.save([user('start', 'orch-worker-model: anthropic/sonnet#high')], `${name}_2`);
  let r = f.runtime();
  assert.deepEqual(await r.discover(1, directory), [`${name}_2`, name]);
  assert.ok(r.backend(name) instanceof V2Backend);
  assert.ok(r.backend(`${name}_2`) instanceof ClaudeBackend);
  await r.say(1, 'reply', 123);
  const delivery = f.calls.find(c => c.file === 'systemd-run')!.args;
  assert.match(delivery.at(-1)!, /^orch-msg: msg_orch_1_say_123\nreply$/);
  assert.equal(delivery[delivery.indexOf('--model') + 1], 'sonnet');
  assert.equal(delivery[delivery.indexOf('--effort') + 1], 'high');
  await assert.rejects(f.runtime().say(1, 'busy', 124), /is active/);
  f.units.add(f.backend(`${name}_3`).unit);
  r = f.runtime();
  assert.deepEqual(await r.discover(1, directory), [`${name}_3`, `${name}_2`, name]);
  assert.equal((await r.backend(`${name}_3`).state()).active, true);
  // V2 still uses its whole list, even beyond a gap in Claude probing.
  f.v2.push({ id: `${name}_7` });
  assert.equal((await f.runtime().discover(1, directory))[0], `${name}_7`);
});

test('inactive Claude orch-ask blocks CI-done and yields asks; active mid-turn line does not', async () => {
  const f = fixture();
  f.save([user('start', 'orch-worker-model: anthropic/sonnet'), assistant('Need input\norch-ask: which option?')]);
  const facts = await f.runtime().localFacts(1, { path: directory, head: 'abc' }, 12346, {}, []);
  facts.pr = { number: 2, head: 'abc', draft: true, merged: false, behind: false, conflict: false };
  facts.ci = 'success';
  assert.deepEqual(facts.requests, [{ id: 'question-uuid', session: name, text: 'orch-ask: which option?' }]);
  const d = decide(facts);
  assert.equal(d.action.kind, 'notify');
  if (d.action.kind === 'notify') {
    assert.match(d.action.id, /_asks_question-uuid$/);
    facts.seen.push(d.action.id);
  }
  assert.equal(decide(facts).action.kind, 'none');
  f.units.add(f.backend().unit);
  assert.deepEqual(await f.backend().pendingRequests(), []);
  const active = await f.runtime().localFacts(1, { path: directory, head: 'abc' }, 12346, {}, []);
  assert.deepEqual(active.requests, []);
  f.units.clear();
  f.save([user('start'), assistant('orch-ask: old?'), user('answer')]);
  assert.deepEqual(await f.backend().pendingRequests(), []);
});

test('provider selects backend, Claude preflight and journal terminal; next start shares suffixes', async () => {
  const f = fixture();
  await f.runtime().start(1, parseStartArgs(['1', '--model', 'anthropic/sonnet#high']).model);
  assert.ok(f.calls.some(c => c.file === 'claude' && c.args[0] === '--version'));
  assert.ok(f.calls.some(c => c.file === 'systemd-run' && c.args[0] === '--version'));
  assert.ok(!f.calls.some(c => c.file === 'opencode2' && c.args[0] === '--version'));
  const terminal = f.calls.find(c => c.file === '/orca-cli' && c.args[0] === 'terminal')!;
  assert.ok(terminal.args.includes(`journalctl --user -f -u ${f.backend().unit}`));
  assert.ok(terminal.args.includes('identity:exact-native-identity'));
  await f.runtime().start(1, parseStartArgs(['1', '--model', 'other/model']).model);
  assert.equal(f.v2.at(-1).id, `${name}_2`);
  assert.deepEqual(f.v2.at(-1).model, { providerID: 'other', id: 'model' });
});

test('runner sends no ordinary Claude prompt while active, retries after exit', async () => {
  const f = fixture(), r = f.runtime();
  f.save([user('start', 'orch-worker-model: anthropic/sonnet')]);
  f.units.add(f.backend().unit);
  const facts = await r.localFacts(1, { path: directory, head: 'abc' }, 12346, {}, []);
  const decision = { stage: 'FIXING' as const, action: { kind: 'prompt' as const, id: 'ci', text: 'fix CI' } };
  await r.execute(facts, decision, {}, undefined, directory);
  assert.ok(!f.calls.some(c => c.file === 'systemd-run'));
  f.units.clear();
  await r.execute(facts, decision, {}, undefined, directory);
  assert.equal(f.calls.filter(c => c.file === 'systemd-run').length, 1);
});

test('Claude unit transport failures do not authorize prompt delivery', async () => {
  const calls: string[] = [];
  const b = new ClaudeBackend(name, directory, async file => {
    calls.push(file);
    throw Object.assign(new Error('user bus unavailable'), { code: 1 });
  }, async () => undefined);
  await b.create(model);
  await assert.rejects(b.prompt('start', 'work'), /user bus unavailable/);
  assert.deepEqual(calls, ['systemctl']);
});
