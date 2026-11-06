import { execFile } from 'node:child_process';
import { readFile, mkdtemp, writeFile, unlink, rmdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { decide, noticeCandidates, shouldReadGitHub, messageID, notice, queueNotice } from './decide.ts';
import type { Facts, Session, Action, Decision } from './decide.ts';
import { parseComments, ciFacts, tierOf, reviewerResult } from './github.ts';
import { defaultWorkerModel } from './start.ts';
import type { WorkerModel } from './start.ts';

export type Run = (file: string, args: string[], cwd?: string, input?: string) => Promise<string>;
export const runCommand: Run = (file, args, cwd, input) => new Promise((resolve, reject) => {
  const child = execFile(file, args, { cwd, maxBuffer: 32 * 1024 * 1024 }, (error, stdout, stderr) => {
    if (error) reject(Object.assign(error, { stdout, stderr }));
    else resolve(stdout);
  });
  child.stdin?.end(input);
});
type Worktree = { path: string; branch?: string; head: string };
export function parseWorktrees(text: string): Worktree[] {
  return text.trim().split('\n\n').filter(Boolean).map(block => {
    const value = (key: string) => block.split('\n').find(l => l.startsWith(`${key} `))?.slice(key.length + 1);
    return { path: value('worktree')!, head: value('HEAD')!, branch: value('branch')?.replace('refs/heads/', '') };
  });
}
export class Runner {
  calls = 0;
  cwd: string;
  env: Record<string, string | undefined>;
  run: Run;
  print: (line: string) => void;
  constructor(cwd: string, env: Record<string, string | undefined>, run: Run = runCommand, print = console.log) {
    this.cwd = cwd; this.env = env; this.run = run; this.print = print;
  }
  async git(args: string[], cwd = this.cwd) { return (await this.run('git', args, cwd)).trim(); }
  async gh(path: string, method = 'GET'): Promise<any> {
    this.calls++;
    return JSON.parse(await this.run('gh', ['api', '--method', method, path], this.cwd));
  }
  async writeGitHub(path: string, method: string, fields: Record<string, string | string[]>) {
    const args = ['api', '--method', method, path];
    for (const [key, value] of Object.entries(fields)) {
      if (Array.isArray(value)) for (const item of value) args.push('-f', `${key}[]=${item}`);
      else args.push('-f', `${key}=${value}`);
    }
    this.calls++;
    return JSON.parse(await this.run('gh', args, this.cwd));
  }
  async pages(path: string, key?: string): Promise<any[]> {
    const all: any[] = [];
    for (let page = 1; ; page++) {
      const response = await this.gh(`${path}${path.includes('?') ? '&' : '?'}per_page=100&page=${page}`);
      const items = key ? response[key] : response;
      all.push(...items);
      if (items.length < 100) return all;
    }
  }
  async api(operation: string, params: Record<string, string> = {}, body?: unknown, absentTags: string[] = []): Promise<any> {
    const args = ['api', operation];
    for (const [k, v] of Object.entries(params)) args.push('--param', `${k}=${v}`);
    if (body !== undefined) args.push('--data', JSON.stringify(body));
    try { return JSON.parse(await this.run('opencode2', args, this.cwd)); }
    catch (error: any) {
      let tag: string | undefined;
      try { tag = JSON.parse(error.stdout)._tag; } catch {}
      if (tag && absentTags.includes(tag)) return undefined;
      throw error;
    }
  }
  async sessions(directory: string): Promise<any[]> {
    const all: any[] = [];
    let cursor: string | undefined;
    do {
      const page = await this.api('session.list', { directory, limit: '100', ...(cursor ? { cursor } : { order: 'desc' }) });
      all.push(...page.data);
      cursor = page.data.length === 100 ? page.cursor?.next : undefined;
    } while (cursor);
    return all;
  }
  async hasMessage(sessionID: string | undefined, id: string): Promise<boolean> {
    if (!sessionID) return false;
    // Do not treat a missing recipient session or an API outage as an absent message.
    const message = await this.api('session.message.get', { sessionID, messageID: id }, undefined, ['MessageNotFoundError']);
    if (message) return true;
    return (await this.api('session.inbox.list', { sessionID })).data.some((m: any) => m.id === id);
  }
  async remember(f: Facts, session: string | undefined, ids: string[]) {
    for (const id of ids) if (await this.hasMessage(session, id)) f.seen.push(id);
  }
  async smokeStarted(sessionID: string | undefined, number: number) {
    if (!sessionID) return false;
    if ((await this.api('session.inbox.list', { sessionID })).data.some((m: any) => m.id.startsWith(`msg_orch_${number}_smoke_`) && !m.id.startsWith(`msg_orch_${number}_smoke_fix_`))) return true;
    let cursor: string | undefined;
    do {
      const page = await this.api('session.message.list', { sessionID, type: 'user', limit: '100', ...(cursor ? { cursor } : {}) });
      if (page.data.some((m: any) => m.id.startsWith(`msg_orch_${number}_smoke_`) && !m.id.startsWith(`msg_orch_${number}_smoke_fix_`))) return true;
      cursor = page.data.length === 100 ? page.cursor?.next : undefined;
    } while (cursor);
    return false;
  }
  async localFacts(number: number, tree: Worktree | undefined, now: number, active: Record<string, any>, operatorSessions: any[]): Promise<Facts> {
    const f: Facts = { number, now, tier: 'T2', requests: [], seen: [], ci: 'pending', reviews: [], smokes: [], statuses: {} };
    const local = tree ? await this.sessions(tree.path) : [];
    const pattern = new RegExp(`^ses_orch_${number}(?:_([2-9]|[1-9][0-9]+))?$`);
    const workers = local.filter(s => pattern.test(s.id)).sort((a, b) => Number(pattern.exec(b.id)?.[1] ?? 1) - Number(pattern.exec(a.id)?.[1] ?? 1));
    f.workerIDs = workers.map(s => s.id);
    const toSession = (s: any): Session => ({ id: s.id, active: Boolean(active[s.id]), created: s.time.created, idle: s.time.idle });
    if (workers[0]) f.worker = toSession((await this.api('session.get', { sessionID: workers[0].id })).data);
    if (tree) {
      const [head, time] = (await this.git(['show', '-s', '--format=%H %ct', 'HEAD'], tree.path)).split(' ');
      f.localHead = head; f.commitTime = Number(time) * 1000;
    }
    const merges = operatorSessions.filter(s => s.id.startsWith(`ses_orch_${number}_merge_`));
    for (const s of [...(f.worker ? [f.worker] : []), ...merges.map(toSession)]) {
      const forms = (await this.api('session.form.list', { sessionID: s.id })).data;
      const permissions = (await this.api('session.permission.list', { sessionID: s.id })).data;
      f.requests.push(...forms.map((r: any) => ({ id: r.id, session: s.id, text: `${r.title} ${JSON.stringify(r.fields)}` })),
        ...permissions.map((r: any) => ({ id: r.id, session: s.id, text: `${r.action} ${JSON.stringify(r.resources)} ${r.message ?? ''}` })));
    }
    const candidates = noticeCandidates(f);
    await this.remember(f, this.env.ORCH_ORCHESTRATOR_SESSION, candidates.map(n => n.id));
    return f;
  }
  async githubFacts(f: Facts, issue: any, operatorSessions: any[]) {
    f.tier = tierOf(issue.body);
    f.escalated = issue.labels.some((l: any) => l.name === 'orch:escalated');
    const prs = await this.pages(`repos/chetwerikoff/orch/pulls?state=all&head=chetwerikoff:orch/${f.number}`);
    const candidate = prs.find(p => p.state === 'open') ?? prs.find(p => p.merged_at);
    if (!candidate) return;
    const p = await this.gh(`repos/chetwerikoff/orch/pulls/${candidate.number}`);
    f.pr = { number: p.number, head: p.head.sha, draft: p.draft, merged: Boolean(p.merged_at), behind: p.mergeable_state === 'behind', conflict: p.mergeable === false };
    f.merge = operatorSessions.find(s => s.id === `ses_orch_${f.number}_merge_${p.head.sha.slice(0, 7)}`);
    if (f.merge) {
      const s: any = f.merge;
      f.merge = { id: s.id, active: s.active, created: s.time.created, idle: s.time.idle };
    }
    const comments = await this.pages(`repos/chetwerikoff/orch/issues/${p.number}/comments`);
    Object.assign(f, parseComments(comments));
    const checks = await this.pages(`repos/chetwerikoff/orch/commits/${p.head.sha}/check-runs`, 'check_runs');
    const statuses = await this.pages(`repos/chetwerikoff/orch/commits/${p.head.sha}/statuses`);
    Object.assign(f, ciFacts(checks, statuses));
    // GitHub has not finished calculating mergeability/required checks yet.
    if (f.ci === 'success' && p.mergeable === null) f.ci = 'pending';
    for (const s of statuses) if (!(s.context in f.statuses)) f.statuses[s.context] = s.state;
    const ids = ['ci', 'cidone', 'smoke_fix', 'smoke', 'base', ...f.reviews.map(r => `review_${r.round}`)].map(k => messageID(f.number, k, p.head.sha));
    await this.remember(f, f.worker?.id, ids);
    for (const id of f.workerIDs ?? []) if (await this.smokeStarted(id, f.number)) { f.smokeStarted = true; break; }
    return { pr: p, comments, checks, statuses };
  }
  async tick(dryRun: boolean, now = Date.now()) {
    this.calls = 0;
    const failedIssues = new Set<number>();
    const failIssue = (number: number, error: unknown) => {
      failedIssues.add(number);
      this.print(`#${number} error: ${error instanceof Error ? error.message : String(error)}`);
    };
    const trees = parseWorktrees(await this.git(['worktree', 'list', '--porcelain']));
    const operator = trees.find(t => t.branch === 'main');
    if (!operator) throw new Error('No operator checkout on main; restore it before ticking.');
    const active = (await this.api('session.active')).data;
    const operatorSessions = (await this.sessions(operator.path)).map(s => ({ ...s, active: Boolean(active[s.id]) }));
    const localTrees = trees.filter(t => /^orch\/\d+$/.test(t.branch ?? ''));
    const locals = new Map<number, Facts>();
    for (const tree of localTrees) {
      const number = Number(tree.branch!.split('/')[1]);
      try { locals.set(number, await this.localFacts(number, tree, now, active, operatorSessions)); }
      catch (error) { failIssue(number, error); }
    }
    const scheduled = Math.floor(now / 60_000) % 5 === 0;
    const issues = scheduled ? (await this.pages('repos/chetwerikoff/orch/issues?state=all&labels=orch%3Aactive')).filter(i => !i.pull_request) : [];
    if (scheduled) {
      try {
        const activeCount = issues.filter(i => i.state === 'open').length;
        if (activeCount < 2) {
          const ready = await this.pages('repos/chetwerikoff/orch/issues?state=open&labels=orch%3Aready');
          const candidate = queueNotice(ready, activeCount, []);
          const seen = candidate.kind === 'notify' && await this.hasMessage(this.env.ORCH_ORCHESTRATOR_SESSION, candidate.id) ? [candidate.id] : [];
          const action = queueNotice(ready, activeCount, seen);
          if (action.kind === 'notify') {
            this.print(`#0 ${JSON.stringify(action)}${dryRun ? ' (dry-run)' : ''}`);
            if (!dryRun) await this.prompt(this.env.ORCH_ORCHESTRATOR_SESSION, action.id, action.text);
          }
        }
      } catch (error) { failIssue(0, error); }
    }
    if (!scheduled) for (const f of locals.values()) if (shouldReadGitHub(f)) {
      try {
        const issue = await this.gh(`repos/chetwerikoff/orch/issues/${f.number}`);
        if (issue.labels.some((l: any) => l.name === 'orch:active')) issues.push(issue);
      } catch (error) { failIssue(f.number, error); }
    }
    for (const issue of issues) {
      if (failedIssues.has(issue.number)) continue;
      try {
        const tree = localTrees.find(t => t.branch === `orch/${issue.number}`);
        const f = locals.get(issue.number) ?? await this.localFacts(issue.number, tree, now, active, operatorSessions);
        const context = await this.githubFacts(f, issue, operatorSessions);
        const decision = decide(f);
        this.print(`#${f.number} ${decision.stage} ${JSON.stringify(decision.action)}${dryRun ? ' (dry-run)' : ''}`);
        if (dryRun && decision.action.kind === 'escalate') {
          const n = notice(f.number, 'escalated', f.pr!.head, `${decision.stage}: ${decision.action.reason}`);
          if (!await this.hasMessage(this.env.ORCH_ORCHESTRATOR_SESSION, n.id)) this.print(JSON.stringify(n) + ' (dry-run)');
        }
        if (!dryRun) await this.execute(f, decision, issue, tree, operator.path, context);
      } catch (error) { failIssue(issue.number, error); }
    }
    if (!issues.length && !failedIssues.size) this.print('No GitHub refresh due or no active Issues.');
    this.print(`GitHub REST calls: ${this.calls}`);
    return failedIssues.size === 0;
  }
  async prompt(sessionID: string | undefined, id: string, text: string, skills?: { id: string }[]) {
    if (!sessionID) throw new Error('Missing destination session; set ORCH_ORCHESTRATOR_SESSION or relaunch the worker with start.');
    if (!await this.hasMessage(sessionID, id)) await this.api('session.prompt', { sessionID }, { id, text, delivery: 'queue', ...(skills ? { skills } : {}) });
  }
  async execute(f: Facts, d: Decision, issue: any, tree: Worktree | undefined, operator: string, context?: unknown) {
    const a = d.action;
    if (a.kind === 'none') return;
    if (a.kind === 'notify') return this.prompt(this.env.ORCH_ORCHESTRATOR_SESSION, a.id, a.text);
    if (a.kind === 'prompt') return this.prompt(f.worker?.id, a.id, a.text);
    if (a.kind === 'finish') return this.removeLabel(f.number, 'orch:active');
    if (a.kind === 'escalate') {
      const n = notice(f.number, 'escalated', f.pr!.head, `${d.stage}: ${a.reason}`);
      await this.prompt(this.env.ORCH_ORCHESTRATOR_SESSION, n.id, n.text);
      const body = `orch-escalation\nstage: ${d.stage}\nreason: ${a.reason}\nnext decision owner: orchestrator (then operator)`;
      const comments = await this.pages(`repos/chetwerikoff/orch/issues/${f.number}/comments`);
      if (!comments.some(c => c.body === body)) await this.writeGitHub(`repos/chetwerikoff/orch/issues/${f.number}/comments`, 'POST', { body });
      await this.writeGitHub(`repos/chetwerikoff/orch/issues/${f.number}/labels`, 'POST', { labels: ['orch:escalated'] });
      return this.removeLabel(f.number, 'orch:active');
    }
    if (a.kind === 'review') {
      if (!tree) throw new Error('Review needs the worker worktree; orchestrator must restore it.');
      return this.review(f, a, issue, tree, context);
    }
    if (a.kind === 'merge') {
      await this.run(this.orca(), ['--version'], this.cwd);
      const id = `ses_orch_${f.number}_merge_${f.pr!.head.slice(0, 7)}`;
      await this.api('session.create', {}, { id, location: { directory: operator }, model: defaultWorkerModel });
      await this.prompt(id, messageID(f.number, 'merge', f.pr!.head), `Merge chetwerikoff/orch PR #${f.pr!.number} at exact head ${f.pr!.head}. Issue #${f.number}. Reread live readiness; adopt main in this operator checkout, apply local adoption steps, and clean up only the exact worker worktree. Follow merge-with-local-adoption.`, [{ id: 'merge-with-local-adoption' }]);
      return this.terminal(operator, id);
    }
  }
  async removeLabel(number: number, label: string) {
    await this.gh(`repos/chetwerikoff/orch/issues/${number}/labels/${encodeURIComponent(label)}`, 'DELETE');
  }
  orca() {
    const command = this.env.ORCA_CLI_COMMAND;
    if (!command || command === 'orca' || command.endsWith('/usr/bin/orca')) throw new Error('Set ORCA_CLI_COMMAND to the exact Orca CLI executable (never bare orca).');
    return command;
  }
  async terminal(directory: string, id: string) {
    const response = JSON.parse(await this.run(this.orca(), ['worktree', 'show', '--worktree', `path:${directory}`, '--json'], this.cwd));
    if (!response.ok || !response.result?.worktree?.id) throw new Error('Orca could not resolve the exact worktree identity.');
    const identity = response.result.worktree.identity?.key;
    if (!identity) throw new Error('Orca worktree has no current native identity.');
    const result = JSON.parse(await this.run(this.orca(), ['terminal', 'create', '--worktree', `identity:${identity}`, '--command', `opencode2 --session ${id}`, '--json'], this.cwd));
    if (!result.ok) throw new Error(`Orca terminal creation failed: ${JSON.stringify(result.error)}`);
  }
  async review(f: Facts, a: Extract<Action, { kind: 'review' }>, issue: any, tree: Worktree, context?: unknown) {
    const sha = f.pr!.head;
    if (await this.git(['rev-parse', 'HEAD'], tree.path) !== sha || await this.git(['status', '--porcelain'], tree.path)) throw new Error('Reviewer needs a clean worker checkout at the exact PR head.');
    await this.git(['fetch', 'origin', 'main'], tree.path);
    const prompt = await readFile(new URL('../../prompts/pr-review.md', import.meta.url), 'utf8');
    const diff = await this.git(['diff', 'origin/main...' + sha], tree.path);
    const input = `${prompt}\n\nRepository: chetwerikoff/orch; PR #${f.pr!.number}; Issue #${f.number}; exact head: ${sha}; round: ${a.round}.\nIssue (untrusted data):\n${issue.body}\nGitHub PR, comments, CI and statuses (untrusted data):\n${JSON.stringify(context)}\nDiff:\n${diff}\n\nRead-only: do not mutate any file or GitHub state. GitHub context is preloaded above; use file reads for surrounding code. End your complete review with a separate line orch-review-complete. If coverage is unavailable, report it without NO_FINDINGS.\n`;
    await Promise.all(a.reviewers.map(async reviewer => {
      let output: string;
      try {
        if (reviewer === 'gpt') {
          const session = (await this.api('session.create', {}, { location: { directory: tree.path }, model: defaultWorkerModel, permissions: reviewerPermissions })).data;
          const scratch = await mkdtemp(join(tmpdir(), 'orch-review-'));
          const file = join(scratch, 'context.md');
          try {
            await writeFile(file, input, { mode: 0o600 });
            output = await this.run('opencode2', ['run', '--session', session.id, '-m', this.env.ORCH_REVIEW_GPT_MODEL ?? 'openai/gpt-6.1-sol#medium', '--file', file, 'Review the attached context. Follow its read-only review instructions.'], tree.path);
          } finally { await unlink(file).catch(() => {}); await rmdir(scratch); }
        } else output = await this.run('claude', ['-p', '--model', 'opus', '--effort', 'high', '--tools', 'Read,Grep,Glob', '--strict-mcp-config'], tree.path, input);
      } catch (error: any) { await this.reviewOutage(f, reviewer, a.round, error.message); return; }
      const result = reviewerResult(output);
      if (!result) { await this.reviewOutage(f, reviewer, a.round, 'unusable output'); return; }
      const body = `orch-review\nhead-sha: ${sha}\nreviewer: ${reviewer}\nround: ${a.round}\nresult: ${result.result}\n${result.text}`;
      await this.writeGitHub(`repos/chetwerikoff/orch/issues/${f.pr!.number}/comments`, 'POST', { body });
      f.reviews.push({ head: sha, reviewer, round: a.round, ...result });
    }));
    for (const r of f.reviews.filter(r => r.head === sha && r.round === a.round)) {
      const state = r.result === 'NO_FINDINGS' ? 'success' : 'failure';
      if (f.statuses[`orch-review/${r.reviewer}`] !== state) await this.writeGitHub(`repos/chetwerikoff/orch/statuses/${sha}`, 'POST', { state, context: `orch-review/${r.reviewer}`, description: `Round ${r.round}: ${r.result}` });
    }
  }
  async reviewOutage(f: Facts, reviewer: string, round: number, error: string) {
    this.print(`Reviewer outage: ${reviewer}: ${error}`);
    const n = notice(f.number, 'review-outage', `${reviewer}_${round}_${f.pr!.head.slice(0, 7)}`, `${reviewer}: ${error}`);
    await this.prompt(this.env.ORCH_ORCHESTRATOR_SESSION, n.id, n.text);
  }
  async start(number: number, model: WorkerModel = defaultWorkerModel) {
    await this.run(this.orca(), ['--version'], this.cwd);
    await this.run('opencode2', ['--version'], this.cwd);
    const issue = await this.gh(`repos/chetwerikoff/orch/issues/${number}`);
    tierOf(issue.body);
    if (issue.state !== 'open' || issue.pull_request) throw new Error('start requires an open Issue.');
    const trees = parseWorktrees(await this.git(['worktree', 'list', '--porcelain']));
    let tree = trees.find(t => t.branch === `orch/${number}`);
    if (!tree) {
      const result = JSON.parse(await this.run(this.orca(), ['worktree', 'create', '--name', `issue-${number}`, '--issue', String(number), '--branch', `orch/${number}`, '--base-branch', 'origin/main', '--no-parent', '--json'], this.cwd));
      if (!result.ok) throw new Error(`Orca worktree creation failed: ${JSON.stringify(result.error)}`);
      tree = parseWorktrees(await this.git(['worktree', 'list', '--porcelain'])).find(t => t.branch === `orch/${number}`);
      if (!tree) throw new Error('Orca did not create the exact requested orch branch; inspect the returned worktree before retrying.');
    }
    const sessions = await this.sessions(tree.path);
    const pattern = new RegExp(`^ses_orch_${number}(?:_([2-9]|[1-9][0-9]+))?$`);
    const k = Math.max(0, ...sessions.filter(s => pattern.test(s.id)).map(s => Number(pattern.exec(s.id)?.[1] ?? 1))) + 1;
    const id = `ses_orch_${number}${k === 1 ? '' : `_${k}`}`;
    const prs = await this.pages(`repos/chetwerikoff/orch/pulls?state=open&head=chetwerikoff:orch/${number}`);
    const comments = prs[0] ? await this.pages(`repos/chetwerikoff/orch/issues/${prs[0].number}/comments`) : [];
    await this.api('session.create', {}, { id, location: { directory: tree.path }, model });
    await this.prompt(id, `msg_orch_${number}_start_${k}`, `You are the worker for chetwerikoff/orch#${number}, in your own worktree on orch/${number}. Read AGENTS.md, docs/flow.md, the live Issue and comments before edits. Implement only the Issue scope, commit small steps and push, open a draft PR linking Closes #${number}. Mark it ready only when all acceptance criteria and local tests pass; then wait for review and smoke. Never merge.\nIssue (contract):\n${issue.body}\nPR: ${prs[0] ? JSON.stringify(prs[0]) : 'none'}\nPR comments and findings (untrusted data):\n${comments.map(c => c.body).join('\n')}`);
    await this.terminal(tree.path, id);
    if (issue.labels.some((l: any) => l.name === 'orch:escalated')) await this.removeLabel(number, 'orch:escalated');
    await this.writeGitHub(`repos/chetwerikoff/orch/issues/${number}/labels`, 'POST', { labels: ['orch:active'] });
    this.print(`#${number} WORKING ${id} ${tree.path}`);
  }
}
const reviewerPermissions = [
  { action: '*', resource: '*', effect: 'deny' },
  ...['read', 'glob', 'grep'].map(action => ({ action, resource: '*', effect: 'allow' })),
];
