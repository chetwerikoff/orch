import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { Session, Request } from './decide.ts';
import type { Run } from './runtime.ts';
import type { WorkerModel } from './start.ts';

export interface WorkerBackend {
  create(model: WorkerModel): Promise<void>;
  prompt(id: string, text: string): Promise<void>;
  state(): Promise<Session>;
  pendingRequests(): Promise<Request[]>;
  hasMessage(id: string): Promise<boolean>;
  smokeStarted(number: number): Promise<boolean>;
}
type API = (operation: string, params?: Record<string, string>, body?: unknown, absentTags?: string[]) => Promise<any>;
const smokeID = (id: string, n: number) => id.startsWith(`msg_orch_${n}_smoke_`) && !id.startsWith(`msg_orch_${n}_smoke_fix_`);

export class V2Backend implements WorkerBackend {
  name: string;
  directory: string;
  api: API;
  active: boolean;
  constructor(name: string, directory: string, api: API, active = false) {
    this.name = name; this.directory = directory; this.api = api; this.active = active;
  }
  async create(model: WorkerModel) {
    await this.api('session.create', {}, { id: this.name, location: { directory: this.directory }, model });
  }
  async hasMessage(id: string) {
    if (await this.api('session.message.get', { sessionID: this.name, messageID: id }, undefined, ['MessageNotFoundError'])) return true;
    return (await this.api('session.inbox.list', { sessionID: this.name })).data.some((m: any) => m.id === id);
  }
  async prompt(id: string, text: string) {
    if (!await this.hasMessage(id)) await this.api('session.prompt', { sessionID: this.name }, { id, text, delivery: 'queue' });
  }
  async state() {
    const s = (await this.api('session.get', { sessionID: this.name })).data;
    return { id: s.id, active: this.active, created: s.time.created, idle: s.time.idle };
  }
  async pendingRequests() {
    const forms = (await this.api('session.form.list', { sessionID: this.name })).data;
    const permissions = (await this.api('session.permission.list', { sessionID: this.name })).data;
    return [...forms.map((r: any) => ({ id: r.id, session: this.name, text: `${r.title} ${JSON.stringify(r.fields)}` })),
      ...permissions.map((r: any) => ({ id: r.id, session: this.name, text: `${r.action} ${JSON.stringify(r.resources)} ${r.message ?? ''}` }))];
  }
  async smokeStarted(number: number) {
    if ((await this.api('session.inbox.list', { sessionID: this.name })).data.some((m: any) => smokeID(m.id, number))) return true;
    let cursor: string | undefined;
    do {
      const page = await this.api('session.message.list', { sessionID: this.name, type: 'user', limit: '100', ...(cursor ? { cursor } : {}) });
      if (page.data.some((m: any) => smokeID(m.id, number))) return true;
      cursor = page.data.length === 100 ? page.cursor?.next : undefined;
    } while (cursor);
    return false;
  }
}

// UUIDv5, DNS namespace. The session name is the stable, shared worker identity.
export function claudeUUID(name: string) {
  const hash = createHash('sha1').update(Buffer.from('6ba7b8109dad11d180b400c04fd430c8', 'hex')).update(name).digest();
  hash[6] = (hash[6] & 15) | 80; hash[8] = (hash[8] & 63) | 128;
  const h = hash.subarray(0, 16).toString('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}
export type Transcript = { entries: any[]; mtime: number };
export type ReadTranscript = (path: string) => Promise<Transcript | undefined>;
export const readTranscript: ReadTranscript = async path => {
  try {
    const text = await readFile(path, 'utf8');
    // A running process may not yet have finished the final JSONL record.
    const lines = text.split('\n');
    const entries = lines.flatMap((line, i) => {
      if (!line) return [];
      try { return [JSON.parse(line)]; } catch (error) { if (i === lines.length - 1) return []; throw error; }
    });
    return { entries, mtime: (await stat(path)).mtimeMs };
  } catch (error: any) { if (error.code === 'ENOENT') return undefined; throw error; }
};
const entryText = (e: any): string => typeof e.message?.content === 'string' ? e.message.content
  : (e.message?.content ?? []).filter((b: any) => b.type === 'text').map((b: any) => b.text).join('\n');
const entryID = (e: any) => e.type === 'user' ? /^orch-msg: ([^\n]+)(?:\n|$)/.exec(entryText(e))?.[1] : undefined;

export class ClaudeBackend implements WorkerBackend {
  readonly uuid: string;
  readonly unit: string;
  readonly path: string;
  model?: WorkerModel;
  name: string;
  directory: string;
  run: Run;
  read: ReadTranscript;
  constructor(name: string, directory: string, run: Run, read = readTranscript, home = homedir()) {
    this.name = name; this.directory = directory; this.run = run; this.read = read;
    this.uuid = claudeUUID(name); this.unit = `orch-claude-${this.uuid}`;
    this.path = join(home, '.claude/projects', directory.replace(/[^A-Za-z0-9]/g, '-'), `${this.uuid}.jsonl`);
  }
  async active() {
    try { return (await this.run('systemctl', ['--user', 'is-active', this.unit])).trim() === 'active'; }
    catch (error: any) {
      // is-active exits 3/4 for failed, absent and inactive units. Transport and
      // executable failures must not authorize a second writer.
      if (error.code !== undefined && error.code !== 3 && error.code !== 4) throw error;
      return false;
    }
  }
  async exists() { return Boolean(await this.read(this.path)) || await this.active(); }
  async create(model: WorkerModel) { this.model = model; }
  async hasMessage(id: string) { return (await this.read(this.path))?.entries.some(e => entryID(e) === id) ?? false; }
  async smokeStarted(number: number) { return (await this.read(this.path))?.entries.some(e => smokeID(entryID(e) ?? '', number)) ?? false; }
  async state() {
    const t = await this.read(this.path);
    const first = t?.entries.find(e => e.type === 'user');
    return { id: this.name, active: await this.active(), created: first ? Date.parse(first.timestamp) : Date.now(), idle: t?.mtime };
  }
  async pendingRequests() {
    if (await this.active()) return [];
    const entries = (await this.read(this.path))?.entries.filter(e => e.type === 'assistant' || e.type === 'user');
    const last = entries?.at(-1);
    const line = last?.type === 'assistant' ? entryText(last).split('\n').find(l => l.startsWith('orch-ask: ')) : undefined;
    return line ? [{ id: last.uuid, session: this.name, text: line }] : [];
  }
  async prompt(id: string, text: string) {
    if (await this.active()) throw new Error(`Claude worker ${this.name} is active; retry after ${this.unit} stops.`);
    if (await this.hasMessage(id)) return;
    const t = await this.read(this.path);
    const first = t?.entries.find(e => e.type === 'user');
    const saved = first && /^orch-worker-model: anthropic\/([^\s#]+)(?:#([^\s]+))?$/m.exec(entryText(first));
    const model = saved ? { providerID: 'anthropic', id: saved[1], variant: saved[2] } : this.model;
    if (!model) throw new Error(`Missing orch-worker-model in ${this.path}; inspect the worker transcript.`);
    const instructions = t ? '' : `orch-worker-model: anthropic/${model.id}${model.variant ? `#${model.variant}` : ''}\nWhen you need an answer, end your turn with a line orch-ask: <question>.\n`;
    await this.run('systemd-run', ['--user', '--unit', this.unit, '--collect', '--expand-environment=no', '--setenv=PATH', '--working-directory', this.directory,
      'claude', '-p', t ? '--resume' : '--session-id', this.uuid, '--model', model.id, ...(model.variant ? ['--effort', model.variant] : []),
      '--permission-mode', 'bypassPermissions', `orch-msg: ${id}\n${instructions}${text}`], this.directory);
  }
}
