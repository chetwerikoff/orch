import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CursorBackend } from './cursor.ts';
import type { Transcript } from './backends.ts';
import { Runner } from './runtime.ts';
import type { Run } from './runtime.ts';
import { parseStartArgs } from './start.ts';

const directory = '/tmp/orch-lens-probe/a.b_c';
const name = 'ses_orch_1';
const uuid = '11111111-1111-4111-8111-111111111111';
const other = '22222222-2222-4222-8222-222222222222';
const model = { providerID: 'cursor', id: 'claude-opus-4-8[effort=high]' };
const user = (body: string) => ({ role: 'user', message: { content: [{ type: 'text', text: body }] } });
const initial = (n = name) => user(`orch-msg: start\norch-worker: ${n}\norch-worker-model: cursor/${model.id}\nwork`);
function fixture() {
  const transcripts = new Map<string, Transcript>();
  const calls: { file: string; args: string[]; cwd?: string }[] = [];
  const units = new Set<string>();
  const v2: any[] = [];
  const read = async (path: string) => transcripts.get(path);
  const list = async (path: string) => [...transcripts.keys()].filter(p => p.startsWith(path + '/')).map(p => p.slice(path.length + 1).split('/')[0]);
  const run: Run = async (file, args, cwd) => {
    calls.push({ file, args, cwd });
    if (args[0] === '--version') return 'test version';
    if (file === 'cursor-agent' && args[0] === 'create-chat') return uuid + '\n';
    if (file === 'systemctl') {
      if (units.has(args.at(-1)!)) return 'active\n';
      throw Object.assign(new Error('inactive'), { code: 3 });
    }
    if (file === 'systemd-run') { units.add(args[args.indexOf('--unit') + 1]); return ''; }
    if (file === 'git') {
      if (args[0] === 'worktree') return `worktree ${directory}\nHEAD abc\nbranch refs/heads/orch/1\n`;
      if (args[0] === 'show') return 'abc 1794009600';
    }
    if (file === 'opencode2') {
      if (args[1] === 'session.list') return JSON.stringify({ data: v2 });
      if (args[1] === 'session.create') { v2.push(JSON.parse(args[args.indexOf('--data') + 1])); return '{}'; }
      if (args[1] === 'session.message.get') throw Object.assign(new Error('missing'), { stdout: '{"_tag":"MessageNotFoundError"}' });
      if (args[1] === 'session.inbox.list') return '{"data":[]}';
      if (args[1] === 'session.prompt') return '{}';
    }
    if (file === 'gh') {
      const path = args[args.indexOf('--method') + 2];
      if (path.endsWith('/issues/1')) return JSON.stringify({ state: 'open', body: '```complexity-tier\ntier: T2\nbecause: test\n```', labels: [] });
      if (path.includes('/pulls?') || path.endsWith('/labels')) return '[]';
    }
    if (file === '/orca-cli') {
      if (args[0] === 'worktree') return '{"ok":true,"result":{"worktree":{"id":"native","identity":{"key":"exact"}}}}';
      if (args[0] === 'terminal') return '{"ok":true}';
    }
    throw new Error(`Unexpected ${file} ${args.join(' ')}`);
  };
  const backend = (n = name) => new CursorBackend(n, directory, run, read, '/home/test', list);
  const save = (id = uuid, entries = [initial()]) => transcripts.set(`${backend().project}/${id}/${id}.jsonl`, { entries, mtime: 12345, birthtime: 1000 });
  const runtime = () => new Runner(directory, { HOME: '/home/test', ORCA_CLI_COMMAND: '/orca-cli' }, run, () => {}, read, list);
  return { backend, save, runtime, calls, units, v2 };
}

test('Cursor model selection, variant rejection, create-chat and journal terminal', async () => {
  assert.deepEqual(parseStartArgs(['1', '--model', `cursor/${model.id}`]).model, model);
  assert.throws(() => parseStartArgs(['1', '--model', 'cursor/opus#high']), /do not accept/);
  const f = fixture();
  const r = f.runtime();
  await r.start(1, model);
  assert.ok(r.backend(name) instanceof CursorBackend);
  assert.ok(f.calls.some(c => c.file === 'cursor-agent' && c.args[0] === '--version'));
  assert.deepEqual(f.calls.find(c => c.file === 'cursor-agent' && c.args[0] === 'create-chat'), { file: 'cursor-agent', args: ['create-chat'], cwd: directory });
  assert.ok(f.calls.some(c => c.file === '/orca-cli' && c.args.includes(`journalctl --user -f -u orch-cursor-${uuid}`)));
  const delivery = f.calls.find(c => c.file === 'systemd-run' && c.args[0] === '--user')!;
  assert.deepEqual(delivery.args.slice(0, -1), ['--user', '--collect', '--unit', `orch-cursor-${uuid}`, '--expand-environment=no', '--setenv=PATH', '--working-directory', directory,
    'cursor-agent', '-p', '--resume', uuid, '--model', model.id, '--force', '--trust', '--output-format', 'text']);
  assert.match(delivery.args.at(-1)!, /^orch-msg: msg_orch_1_start_1\norch-worker: ses_orch_1\norch-worker-model: cursor\//);
  assert.equal(delivery.cwd, directory);
});

test('Cursor discovers only first-user markers among chats in encoded project', async () => {
  const f = fixture();
  assert.equal(f.backend().project, '/home/test/.cursor/projects/tmp-orch-lens-probe-a-b-c/agent-transcripts');
  assert.deepEqual(await f.runtime().discover(1, directory), []);
  f.save(other, [user('unmarked'), initial()]);
  assert.deepEqual(await f.runtime().discover(1, directory), []);
  f.save();
  const b = f.backend();
  assert.equal((await b.chat())?.id, uuid);
  assert.deepEqual(await b.state(), { id: name, active: false, created: 1000, idle: 12345 });
  assert.deepEqual(await b.pendingRequests(), []);
  await b.prompt('next', 'literal $HOME ${X}');
  const args = f.calls.find(c => c.file === 'systemd-run')!.args;
  assert.equal(args[args.indexOf('--model') + 1], model.id);
  assert.equal(args.at(-1), 'orch-msg: next\nliteral $HOME ${X}');
  await assert.rejects(b.prompt('busy', 'wait'), /is active/);
  f.units.clear();
  await b.prompt('after-failure', 'retry');
  assert.equal(f.calls.filter(c => c.file === 'systemd-run').length, 2);
});

test('Cursor dedup and smoke history read user first lines only', async () => {
  const f = fixture();
  f.save(uuid, [initial(), user('orch-msg: msg_orch_1_smoke_fix_abc\nfix'), { role: 'assistant', message: { content: 'orch-msg: fake' } }, user('quote\norch-msg: fake')]);
  const b = f.backend();
  assert.equal(await b.hasMessage('fake'), false);
  assert.equal(await b.hasMessage('msg_orch_1_smoke_fix_abc'), true);
  assert.equal(await b.smokeStarted(1), false);
  await b.prompt('msg_orch_1_smoke_fix_abc', 'duplicate');
  assert.ok(!f.calls.some(c => c.file === 'systemd-run'));
  f.save(uuid, [initial(), user('orch-msg: msg_orch_1_smoke_abc\nsmoke')]);
  assert.equal(await b.smokeStarted(1), true);
});

test('duplicate Cursor identities fail every backend operation and discovery with chat IDs', async () => {
  const f = fixture();
  f.save(); f.save(other);
  const b = f.backend();
  for (const operation of [() => b.create(model), () => b.prompt('next', 'work'), () => b.state(), () => b.pendingRequests(), () => b.hasMessage('start'), () => b.smokeStarted(1), () => f.runtime().discover(1, directory)]) {
    await assert.rejects(operation(), error => error instanceof Error && error.message.includes(uuid) && error.message.includes(other));
  }
});

test('latest suffix and allocation are shared between Cursor and V2, even past gaps', async () => {
  const f = fixture();
  f.v2.push({ id: name });
  f.save(uuid, [initial(`${name}_3`)]);
  const r = f.runtime();
  assert.deepEqual(await r.discover(1, directory), [`${name}_3`, name]);
  await r.say(1, 'answer', 123);
  assert.equal(f.calls.find(c => c.file === 'systemd-run')!.args.at(-1), 'orch-msg: msg_orch_1_say_123\nanswer');
  await f.runtime().start(1, { providerID: 'openai', id: 'model' });
  assert.equal(f.v2.at(-1).id, `${name}_4`);
  f.v2.push({ id: `${name}_7` });
  assert.equal((await f.runtime().discover(1, directory))[0], `${name}_7`);
});

test('runner defers ordinary Cursor prompts until the unit exits', async () => {
  const f = fixture(); f.save(); f.units.add(`orch-cursor-${uuid}`);
  const r = f.runtime();
  const facts = await r.localFacts(1, { path: directory, head: 'abc' }, 12346, {}, []);
  const decision = { stage: 'FIXING' as const, action: { kind: 'prompt' as const, id: 'ci', text: 'fix CI' } };
  await r.execute(facts, decision, {}, undefined, directory);
  assert.ok(!f.calls.some(c => c.file === 'systemd-run'));
  f.units.clear();
  await r.execute(facts, decision, {}, undefined, directory);
  assert.equal(f.calls.filter(c => c.file === 'systemd-run').length, 1);
});

test('Cursor user-bus failures never authorize a writer', async () => {
  const f = fixture(); f.save();
  const b = f.backend();
  b.run = async () => { throw Object.assign(new Error('bus unavailable'), { code: 1 }); };
  await assert.rejects(b.prompt('next', 'work'), /bus unavailable/);
});
