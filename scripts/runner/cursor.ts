import { readdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { readTranscript } from './backends.ts';
import type { ReadTranscript, Transcript, WorkerBackend } from './backends.ts';
import type { Run } from './runtime.ts';
import type { WorkerModel } from './start.ts';

export type ListChats = (path: string) => Promise<string[]>;
export const listChats: ListChats = async path => {
  try { return await readdir(path); }
  catch (error: any) { if (error.code === 'ENOENT') return []; throw error; }
};
const text = (e: any): string => typeof e.message?.content === 'string' ? e.message.content
  : (e.message?.content ?? []).filter((b: any) => b.type === 'text').map((b: any) => b.text).join('\n');
const messageID = (e: any) => {
  if (e.role !== 'user') return undefined;
  // Print-mode transcripts prepend Cursor metadata to the original prompt.
  // Strip only that prefix, not arbitrary lines containing quoted message IDs.
  const prompt = text(e).replace(/^(?:<timestamp>[^\n]*<\/timestamp>\n)?<user_query>\n/, '');
  return /^orch-msg: ([^\n]+)(?:\n|$)/.exec(prompt)?.[1];
};
const firstUser = (t: Transcript) => t.entries.find(e => e.role === 'user');
type Chat = { id: string; path: string; transcript: Transcript };

export class CursorBackend implements WorkerBackend {
  name: string;
  directory: string;
  run: Run;
  read: ReadTranscript;
  list: ListChats;
  project: string;
  bootstrap?: string;
  model?: WorkerModel;
  constructor(name: string, directory: string, run: Run, read = readTranscript, home = homedir(), list = listChats) {
    this.name = name; this.directory = directory; this.run = run; this.read = read; this.list = list;
    this.project = join(home, '.cursor/projects', directory.replace(/^\//, '').replace(/[\/._]/g, '-'), 'agent-transcripts');
  }
  async chats() {
    const chats = new Map<string, Chat[]>();
    for (const id of await this.list(this.project)) {
      const path = join(this.project, id, `${id}.jsonl`);
      const transcript = await this.read(path);
      if (!transcript) continue;
      const first = firstUser(transcript);
      const name = first && /^orch-worker: (ses_orch_\d+(?:_\d+)?)$/m.exec(text(first))?.[1];
      if (name) chats.set(name, [...(chats.get(name) ?? []), { id, path, transcript }]);
    }
    return chats;
  }
  async chat() {
    const matches = (await this.chats()).get(this.name) ?? [];
    if (matches.length > 1) throw new Error(`Ambiguous Cursor worker ${this.name}: ${matches.map(c => c.id).join(', ')}`);
    return matches[0];
  }
  async unit() {
    const id = (await this.chat())?.id ?? this.bootstrap;
    if (!id) throw new Error(`No Cursor transcript for ${this.name}; inspect the worker before retrying start.`);
    return `orch-cursor-${id}`;
  }
  async active() {
    const unit = await this.unit();
    try { return (await this.run('systemctl', ['--user', 'is-active', unit])).trim() === 'active'; }
    catch (error: any) {
      if (error.code !== undefined && error.code !== 3 && error.code !== 4) throw error;
      return false;
    }
  }
  async create(model: WorkerModel) {
    if (model.variant) throw new Error('Cursor models do not accept #<variant>');
    await this.chat(); // Duplicate identities must fail even during creation.
    this.model = model;
    const id = (await this.run('cursor-agent', ['create-chat'], this.directory)).trim();
    if (!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(id)) throw new Error(`cursor-agent create-chat did not return a bare UUID: ${id}`);
    this.bootstrap = id;
  }
  async hasMessage(id: string) { return (await this.chat())?.transcript.entries.some(e => messageID(e) === id) ?? false; }
  async smokeStarted(number: number) {
    return (await this.chat())?.transcript.entries.some(e => {
      const id = messageID(e) ?? '';
      return id.startsWith(`msg_orch_${number}_smoke_`) && !id.startsWith(`msg_orch_${number}_smoke_fix_`);
    }) ?? false;
  }
  async pendingRequests() { await this.chat(); return []; }
  async state() {
    const t = (await this.chat())?.transcript;
    if (!t?.birthtime) throw new Error(`Missing Cursor transcript birth time for ${this.name}`);
    return { id: this.name, active: await this.active(), created: t.birthtime, idle: t.mtime };
  }
  async prompt(id: string, body: string) {
    if (await this.active()) throw new Error(`Cursor worker ${this.name} is active; retry after ${await this.unit()} stops.`);
    if (await this.hasMessage(id)) return;
    const chat = await this.chat();
    const saved = chat && /^orch-worker-model: cursor\/([^\n]+)$/m.exec(text(firstUser(chat.transcript)));
    const model = saved?.[1] ?? this.model?.id;
    if (!model) throw new Error(`Missing orch-worker-model for ${this.name}; inspect the Cursor transcript.`);
    const instructions = chat ? '' : `orch-worker: ${this.name}\norch-worker-model: cursor/${model}\n`;
    await this.run('systemd-run', ['--user', '--collect', '--unit', await this.unit(), '--expand-environment=no', '--setenv=PATH', '--working-directory', this.directory,
      'cursor-agent', '-p', '--resume', chat?.id ?? this.bootstrap!, '--model', model, '--force', '--trust', '--output-format', 'text', `orch-msg: ${id}\n${instructions}${body}`], this.directory);
  }
}
