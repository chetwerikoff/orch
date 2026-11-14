import { execFile } from 'node:child_process';
import { readFile, mkdtemp, writeFile, unlink, rmdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { decide, noticeCandidates, shouldReadGitHub, messageID, notice, queueNotice, trainCandidate } from './decide.ts';
import type { Facts, Session, Action, Decision } from './decide.ts';
import { parseComments, ciFacts, tierOf, smokeNotApplicable, reviewerResult } from './github.ts';
import { parseTrains, trainBranchName, trainIsRed } from './train.ts';
import type { TrainRef, TrainRefs } from './train.ts';
import { defaultMergeModel, defaultWorkerModel } from './start.ts';
import type { WorkerModel } from './start.ts';
import { V2Backend, ClaudeBackend, readTranscript } from './backends.ts';
import type { WorkerBackend, ReadTranscript } from './backends.ts';
import { CursorBackend, listChats } from './cursor.ts';
import type { ListChats } from './cursor.ts';

export type Run = (file: string, args: string[], cwd?: string, input?: string) => Promise<string>;
export const runCommand: Run = (file, args, cwd, input) => new Promise((resolve, reject) => {
  const child = execFile(file, args, { cwd, maxBuffer: 32 * 1024 * 1024 }, (error, stdout, stderr) => {
    if (error) reject(Object.assign(error, { stdout, stderr }));
    else resolve(stdout);
  });
  child.stdin?.end(input);
});
type Worktree = { path: string; branch?: string; head: string };
type IssuePlan = { f: Facts; d: Decision; issue: any; tree?: Worktree; context?: unknown };
type TrainTick = {
  dryRun: boolean; now: number; refs: TrainRefs; issues: any[]; localTrees: Worktree[];
  collected: IssuePlan[]; failedIssues: Set<number>; operator: string; operatorSessions: any[];
};
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
  workers = new Map<string, WorkerBackend>();
  readTranscript: ReadTranscript;
  listChats: ListChats;
  constructor(cwd: string, env: Record<string, string | undefined>, run: Run = runCommand, print = console.log, read: ReadTranscript = readTranscript, list: ListChats = listChats) {
    this.cwd = cwd; this.env = env; this.run = run; this.print = print;
    this.readTranscript = read;
    this.listChats = list;
  }
  v2(id: string, directory = this.cwd, active = false) { return new V2Backend(id, directory, this.api.bind(this), active); }
  claude(id: string, directory: string) { return new ClaudeBackend(id, directory, this.run, this.readTranscript, this.env.HOME); }
  cursor(id: string, directory: string) { return new CursorBackend(id, directory, this.run, this.readTranscript, this.env.HOME, this.listChats); }
  backend(id: string) { return this.workers.get(id) ?? this.v2(id); }
  async discover(number: number, directory: string, active: Record<string, any> = {}) {
    const local = await this.sessions(directory);
    const pattern = new RegExp(`^ses_orch_${number}(?:_([2-9]|[1-9][0-9]+))?$`);
    const names = new Set<string>();
    for (const s of local.filter(s => pattern.test(s.id))) {
      names.add(s.id); this.workers.set(s.id, this.v2(s.id, directory, Boolean(active[s.id])));
    }
    for (const name of (await this.cursor('', directory).chats()).keys()) if (pattern.test(name)) {
      const cursor = this.cursor(name, directory);
      await cursor.chat(); // Refuse ambiguous identities before choosing any worker.
      names.add(name); this.workers.set(name, cursor);
    }
    for (let k = 1; ; k++) {
      const name = `ses_orch_${number}${k === 1 ? '' : `_${k}`}`;
      const claude = this.claude(name, directory);
      if (await claude.exists()) { names.add(name); this.workers.set(name, claude); }
      else if (!names.has(name)) break;
    }
    return [...names].sort((a, b) => Number(pattern.exec(b)?.[1] ?? 1) - Number(pattern.exec(a)?.[1] ?? 1));
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
    return this.backend(sessionID).hasMessage(id);
  }
  async remember(f: Facts, session: string | undefined, ids: string[]) {
    for (const id of ids) if (await this.hasMessage(session, id)) f.seen.push(id);
  }
  async smokeStarted(sessionID: string | undefined, number: number) {
    if (!sessionID) return false;
    return this.backend(sessionID).smokeStarted(number);
  }
  async localFacts(number: number, tree: Worktree | undefined, now: number, active: Record<string, any>, operatorSessions: any[]): Promise<Facts> {
    const f: Facts = { number, now, tier: 'T2', requests: [], seen: [], ci: 'pending', reviews: [], smokes: [], statuses: {} };
    const workers = tree ? await this.discover(number, tree.path, active) : [];
    f.workerIDs = workers;
    const toSession = (s: any): Session => ({ id: s.id, active: Boolean(active[s.id]), created: s.time.created, idle: s.time.idle });
    if (workers[0]) f.worker = await this.backend(workers[0]).state();
    if (tree) {
      const [head, time] = (await this.git(['show', '-s', '--format=%H %ct', 'HEAD'], tree.path)).split(' ');
      f.localHead = head; f.commitTime = Number(time) * 1000;
    }
    const merges = operatorSessions.filter(s => s.id.startsWith(`ses_orch_${number}_merge_`));
    for (const s of [...(f.worker ? [f.worker] : []), ...merges.map(toSession)]) {
      f.requests.push(...await this.backend(s.id).pendingRequests());
    }
    const candidates = noticeCandidates(f);
    await this.remember(f, this.env.ORCH_ORCHESTRATOR_SESSION, candidates.map(n => n.id));
    return f;
  }
  async githubFacts(f: Facts, issue: any, operatorSessions: any[]) {
    f.tier = tierOf(issue.body);
    f.smokeNotApplicable = smokeNotApplicable(issue.body);
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
    const urgent = !scheduled ? [...locals.values()].filter(f => shouldReadGitHub(f)) : [];
    // Train branch names are the only train state; read them before any Issue refresh.
    const refs = scheduled || urgent.length
      ? parseTrains(await this.run('git', ['ls-remote', 'origin', 'refs/heads/main', 'refs/heads/orch/train/*'], this.cwd))
      : undefined;
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
    if (!scheduled) for (const f of urgent) {
      try {
        const issue = await this.gh(`repos/chetwerikoff/orch/issues/${f.number}`);
        if (issue.labels.some((l: any) => l.name === 'orch:active')) issues.push(issue);
      } catch (error) { failIssue(f.number, error); }
    }
    // Scheduled ticks collect every Issue's facts and decisions before acting.
    const collected: IssuePlan[] = [];
    for (const issue of issues) {
      if (failedIssues.has(issue.number)) continue;
      try {
        const tree = localTrees.find(t => t.branch === `orch/${issue.number}`);
        const f = locals.get(issue.number) ?? await this.localFacts(issue.number, tree, now, active, operatorSessions);
        const context = await this.githubFacts(f, issue, operatorSessions);
        collected.push({ f, d: decide(f), issue, tree, context });
      } catch (error) { failIssue(issue.number, error); }
    }
    const suppressed = new Set<number>();
    if (refs) {
      if (!scheduled) for (const train of refs.trains) for (const n of train.members) suppressed.add(n);
      else {
        const tickContext: TrainTick = { dryRun, now, refs, issues, localTrees, collected, failedIssues, operator: operator.path, operatorSessions };
        try { await this.evaluateTrains(tickContext, suppressed); }
        catch (error) { failIssue(0, error); }
      }
    }
    for (const { f, d: plan, issue, tree, context } of collected) {
      try {
        // Train members get neither merge nor base while their train holds them.
        const base = plan.action.kind === 'prompt' && plan.action.id.startsWith(`msg_orch_${f.number}_base_`);
        const suppressedAction = suppressed.has(f.number) && (plan.action.kind === 'merge' || base);
        const d: Decision = suppressedAction ? { stage: plan.stage, action: { kind: 'none' } } : plan;
        this.print(`#${f.number} ${d.stage} ${JSON.stringify(d.action)}${dryRun ? ' (dry-run)' : ''}`);
        if (dryRun && d.action.kind === 'escalate') {
          const n = notice(f.number, 'escalated', f.pr!.head, `${d.stage}: ${d.action.reason}`);
          if (!await this.hasMessage(this.env.ORCH_ORCHESTRATOR_SESSION, n.id)) this.print(JSON.stringify(n) + ' (dry-run)');
        }
        if (!dryRun) await this.execute(f, d, issue, tree, operator.path, context);
      } catch (error) { failIssue(f.number, error); }
    }
    if (!issues.length && !failedIssues.size) this.print('No GitHub refresh due or no active Issues.');
    this.print(`GitHub REST calls: ${this.calls}`);
    return failedIssues.size === 0;
  }
  // Classify, land, clean, and build trains on a scheduled tick. Members of a current
  // non-red train or a landed train get no merge/base action this tick.
  async evaluateTrains(t: TrainTick, suppressed: Set<number>) {
    if (!t.refs.main) throw new Error('git ls-remote listed no refs/heads/main; inspect the remote before handling trains.');
    if (!t.dryRun && t.refs.trains.length) await this.git(['fetch', 'origin', 'main', '+refs/heads/orch/train/*:refs/remotes/origin/orch/train/*']);
    const factsOf = new Map(t.collected.map(c => [c.f.number, c.f]));
    let open = false;    // a current train exists (red or not)
    let blocked = false; // a train could not be classified this tick
    for (const train of [...t.refs.trains].sort((a, b) => a.name.localeCompare(b.name))) {
      try {
        if (train.members.some(n => t.failedIssues.has(n))) {
          // A member's facts failed: no landing, no deletion, members stay suppressed.
          for (const n of train.members) suppressed.add(n);
          blocked = true;
          this.print(`train ${train.name} unclassified: member facts failed this tick`);
          continue;
        }
        let landed: boolean, base: string | undefined;
        try {
          landed = train.sha === t.refs.main || await this.isAncestor(train.sha, t.refs.main);
          base = landed ? undefined : await this.trainBase(train, factsOf, t.refs.main);
        } catch (error) {
          if (!t.dryRun) throw error;
          for (const n of train.members) suppressed.add(n);
          blocked = true;
          this.print(`train ${train.name} unverified: needed objects are not local (dry-run)`);
          continue;
        }
        if (landed) {
          for (const n of train.members) suppressed.add(n);
          this.print(`train ${train.name} landed`);
          await this.landedTrain(train, t);
          continue;
        }
        if (!base) {
          this.print(`train ${train.name} stale; would delete${t.dryRun ? ' (dry-run)' : ''}`);
          if (!t.dryRun) await this.deleteTrain(train.name, 'stale');
          continue;
        }
        open = true;
        const ci = await this.trainCI(train.sha);
        const commitTime = await this.trainCommitTime(train.sha);
        if (trainIsRed(ci.ci, commitTime, t.now)) {
          const facts = ci.ci === 'failure' ? (ci.ciFailures ?? []).join('; ') || 'failed checks'
            : `no green CI ${Math.round((t.now - commitTime) / 60_000)} minutes after the train commit`;
          this.print(`train ${train.name} red: ${facts}`);
          const n = notice(0, 'train-red', train.sha.slice(0, 7), `${train.name}: ${facts}`);
          if (!t.dryRun) await this.prompt(this.env.ORCH_ORCHESTRATOR_SESSION, n.id, n.text);
          continue;
        }
        for (const n of train.members) suppressed.add(n);
        if (ci.ci !== 'success') {
          this.print(`train ${train.name} current; CI pending`);
          continue;
        }
        this.print(`train ${train.name} green; would land on main${t.dryRun ? ' (dry-run)' : ''}`);
        if (!t.dryRun) await this.landTrain(train, base, t);
      } catch (error) {
        for (const n of train.members) suppressed.add(n);
        throw error;
      }
    }
    if (blocked || open) return;
    await this.buildTrain(t, suppressed);
  }

  // The base SHA when the train is current: origin/main equals its base, its
  // first-parent chain is exactly one --no-ff merge per member back to the base,
  // each merge's second parent equals that member's PR head, and every member is
  // still a candidate on this tick.
  async trainBase(train: TrainRef, factsOf: Map<number, Facts>, main: string): Promise<string | undefined> {
    const lines = (await this.run('git', ['log', '--first-parent', `--max-count=${train.members.length + 1}`, '--format=%H %P', train.sha], this.cwd))
      .trim().split('\n').filter(Boolean).map(line => line.split(' '));
    if (lines.length !== train.members.length + 1) return;
    const base = lines.at(-1)![0];
    if (base !== main) return;
    const order = [...train.members].reverse(); // the tip is the last member merged
    for (let i = 0; i < order.length; i++) {
      const [, p1, p2, ...extra] = lines[i];
      if (extra.length || !p1 || !p2) return;
      if (factsOf.get(order[i])?.pr?.head !== p2) return;
    }
    if (!train.members.every(n => { const f = factsOf.get(n); return f !== undefined && trainCandidate(f); })) return;
    return base;
  }

  async isAncestor(a: string, b: string): Promise<boolean> {
    try { await this.run('git', ['merge-base', '--is-ancestor', a, b], this.cwd); return true; }
    catch (error: any) { if (error.code === 1) return false; throw error; }
  }

  async trainCI(sha: string): Promise<Pick<Facts, 'ci' | 'ciFailures'>> {
    const checks = await this.pages(`repos/chetwerikoff/orch/commits/${sha}/check-runs`, 'check_runs');
    return ciFacts(checks, []);
  }

  async trainCommitTime(sha: string): Promise<number> {
    return Number(await this.git(['show', '-s', '--format=%ct', sha])) * 1000;
  }

  async deleteTrain(name: string, reason: string) {
    await this.git(['push', 'origin', '--delete', `refs/heads/${name}`]);
    this.print(`train ${name} branch deleted (${reason})`);
  }

  async landTrain(train: TrainRef, base: string, t: TrainTick) {
    try {
      await this.git(['push', 'origin', `${train.sha}:refs/heads/main`]);
    } catch (pushError) {
      // Never parse push stderr; re-read the remote and decide from facts.
      const reread = parseTrains(await this.run('git', ['ls-remote', 'origin', 'refs/heads/main'], this.cwd)).main;
      await this.git(['fetch', 'origin', 'main']);
      if (reread && (reread === train.sha || await this.isAncestor(train.sha, reread))) {
        this.print(`train ${train.name} push reported an error but main is at the train; landed`);
      } else if (reread !== base) {
        this.print(`train ${train.name} landing failed: main moved; deleting`);
        return this.deleteTrain(train.name, 'main moved');
      } else throw pushError;
    }
    this.print(`train ${train.name} landed on main at ${train.sha.slice(0, 7)}`);
    return this.landedTrain(train, t);
  }

  // Idempotent landed-train steps in order: close member Issues, start the adoption
  // session, delete the branch last. A crash at any step resumes from the branch.
  async landedTrain(train: TrainRef, t: TrainTick) {
    const sessionID = `ses_orch_train_${train.sha.slice(0, 7)}`;
    const session = t.operatorSessions.find(s => s.id === sessionID);
    if (session) for (const request of await this.backend(sessionID).pendingRequests()) {
      const n = notice(0, 'asks', request.id, `${sessionID}: ${request.text}`);
      if (t.dryRun) { if (!await this.hasMessage(this.env.ORCH_ORCHESTRATOR_SESSION, n.id)) this.print(JSON.stringify(n) + ' (dry-run)'); }
      else await this.prompt(this.env.ORCH_ORCHESTRATOR_SESSION, n.id, n.text);
    }
    for (const n of train.members) {
      if (t.issues.find(i => i.number === n)?.state !== 'open') continue;
      if (t.dryRun) { this.print(`train ${train.name} would close #${n} (dry-run)`); continue; }
      await this.writeGitHub(`repos/chetwerikoff/orch/issues/${n}`, 'PATCH', { state: 'closed' });
    }
    if (!session) {
      if (t.dryRun) return this.print(`train ${train.name} would start adoption session ${sessionID} (dry-run)`);
      await this.run(this.orca(), ['--version'], this.cwd);
      await this.api('session.create', {}, { id: sessionID, location: { directory: t.operator }, model: defaultMergeModel });
      const members = train.members.map(n => {
        const f = t.collected.find(c => c.f.number === n)?.f;
        const tree = t.localTrees.find(w => w.branch === `orch/${n}`);
        return `Issue #${n}: PR #${f?.pr?.number} head ${f?.pr?.head}${tree ? ` worktree ${tree.path}` : ' (no local worktree)'}`;
      }).join('\n');
      await this.prompt(sessionID, messageID(0, 'train', train.sha.slice(0, 7)),
        `The runner landed merge train ${train.name} on chetwerikoff/orch by fast-forwarding main to MERGE_SHA=${train.sha}. Nothing is left to merge.\nMembers:\n${members}\nAdopt main at MERGE_SHA in this operator checkout (fetch and fast-forward, then local adoption steps), and clean up every member worktree and branch by merge-with-local-adoption. Report GitHub state, local adoption, and each worktree cleanup separately and truthfully. Do not merge anything.`,
        [{ id: 'merge-with-local-adoption' }]);
      return this.terminal(t.operator, sessionID);
    }
    if (session.active) return;
    // Only members still listed with orch:active need a merged read; the rest finished.
    const listed = train.members.filter(n => t.issues.some(i => i.number === n));
    if (listed.some(n => !t.collected.find(c => c.f.number === n)?.f.pr?.merged)) return;
    const left = train.members.filter(n => t.localTrees.some(w => w.branch === `orch/${n}`));
    if (left.length) {
      const n = notice(0, 'train-adoption', train.sha.slice(0, 7), `${train.name}: adoption session ${sessionID} stopped with worktrees left: ${left.map(x => `orch/${x}`).join(', ')}`);
      if (t.dryRun) { if (!await this.hasMessage(this.env.ORCH_ORCHESTRATOR_SESSION, n.id)) this.print(JSON.stringify(n) + ' (dry-run)'); }
      else await this.prompt(this.env.ORCH_ORCHESTRATOR_SESSION, n.id, n.text);
    }
    if (t.dryRun) return this.print(`train ${train.name} would delete branch (dry-run)`);
    return this.deleteTrain(train.name, 'landed');
  }

  async buildTrain(t: TrainTick, suppressed: Set<number>) {
    // Suppressed members already belong to a train (landing or current); never retrain them.
    const candidates = t.collected
      .filter(c => c.issue.state === 'open' && !suppressed.has(c.f.number) && trainCandidate(c.f))
      .sort((a, b) => a.f.number - b.f.number);
    if (candidates.length < 2) return;
    const name = trainBranchName(t.refs.main!, candidates.map(c => c.f.number));
    if (t.dryRun) return this.print(`train ${name} would build: ${candidates.map(c => `#${c.f.number}`).join(' ')} (dry-run)`);
    const verified: IssuePlan[] = [];
    for (const c of candidates) {
      await this.git(['fetch', 'origin', 'main', `refs/heads/orch/${c.f.number}`]);
      if (await this.git(['rev-parse', `refs/remotes/origin/orch/${c.f.number}`]) === c.f.pr!.head) verified.push(c);
      else this.print(`train: #${c.f.number} dropped; fetched branch head differs from the PR head`);
    }
    if (verified.length < 2) return this.print(`train ${name} not built: fewer than two verified members`);
    const merged: IssuePlan[] = [];
    const dir = await mkdtemp(join(tmpdir(), 'orch-train-'));
    let added = false;
    try {
      await this.git(['worktree', 'add', '--detach', dir, t.refs.main!]);
      added = true;
      for (const c of verified) {
        try { await this.git(['merge', '--no-ff', '--no-edit', c.f.pr!.head], dir); merged.push(c); }
        catch { await this.git(['merge', '--abort'], dir); this.print(`train: #${c.f.number} dropped after a textual conflict`); }
      }
      if (merged.length < 2) return this.print('train not built: fewer than two members merge cleanly');
      const tip = await this.git(['rev-parse', 'HEAD'], dir);
      const branch = trainBranchName(t.refs.main!, merged.map(c => c.f.number));
      await this.git(['push', 'origin', `${tip}:refs/heads/${branch}`]);
      for (const c of merged) suppressed.add(c.f.number);
      this.print(`train ${branch} built at ${tip.slice(0, 7)}; CI runs on the push`);
    } finally {
      if (added) await this.git(['worktree', 'remove', '--force', dir]);
      else await rmdir(dir).catch(() => {});
    }
  }

  async prompt(sessionID: string | undefined, id: string, text: string, skills?: { id: string }[]) {
    if (!sessionID) throw new Error('Missing destination session; set ORCH_ORCHESTRATOR_SESSION or relaunch the worker with start.');
    if (!skills) return this.backend(sessionID).prompt(id, text);
    if (!await this.hasMessage(sessionID, id)) await this.api('session.prompt', { sessionID }, { id, text, delivery: 'queue', ...(skills ? { skills } : {}) });
  }
  async execute(f: Facts, d: Decision, issue: any, tree: Worktree | undefined, operator: string, context?: unknown) {
    const a = d.action;
    if (a.kind === 'none') return;
    if (a.kind === 'notify') return this.prompt(this.env.ORCH_ORCHESTRATOR_SESSION, a.id, a.text);
    if (a.kind === 'prompt') {
      if (f.worker && (this.backend(f.worker.id) instanceof ClaudeBackend || this.backend(f.worker.id) instanceof CursorBackend) && (await this.backend(f.worker.id).state()).active) return;
      return this.prompt(f.worker?.id, a.id, a.text);
    }
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
      await this.api('session.create', {}, { id, location: { directory: operator }, model: defaultMergeModel });
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
    const backend = this.backend(id);
    const command = backend instanceof CursorBackend ? `journalctl --user -f -u ${await backend.unit()}`
      : backend instanceof ClaudeBackend ? `journalctl --user -f -u ${backend.unit}` : `opencode2 --session ${id}`;
    const result = JSON.parse(await this.run(this.orca(), ['terminal', 'create', '--worktree', `identity:${identity}`, '--command', command, '--json'], this.cwd));
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
  async say(number: number, text: string, now = Date.now()) {
    const trees = parseWorktrees(await this.git(['worktree', 'list', '--porcelain']));
    const tree = trees.find(t => t.branch === `orch/${number}`);
    if (!tree) throw new Error(`No worktree for Issue #${number}; restore it before replying.`);
    const [id] = await this.discover(number, tree.path);
    if (!id) throw new Error(`No worker for Issue #${number}; use start.`);
    await this.prompt(id, messageID(number, 'say', now), text);
  }
  async start(number: number, model: WorkerModel = defaultWorkerModel) {
    await this.run(this.orca(), ['--version'], this.cwd);
    const isClaude = model.providerID === 'anthropic';
    const isCursor = model.providerID === 'cursor';
    if (isCursor && model.variant) throw new Error('Cursor models do not accept #<variant>');
    await this.run(isCursor ? 'cursor-agent' : isClaude ? 'claude' : 'opencode2', ['--version'], this.cwd);
    if (isClaude || isCursor) await this.run('systemd-run', ['--version'], this.cwd);
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
    const sessions = await this.discover(number, tree.path);
    const pattern = new RegExp(`^ses_orch_${number}(?:_([2-9]|[1-9][0-9]+))?$`);
    const k = Math.max(0, ...sessions.map(id => Number(pattern.exec(id)?.[1] ?? 1))) + 1;
    const id = `ses_orch_${number}${k === 1 ? '' : `_${k}`}`;
    const prs = await this.pages(`repos/chetwerikoff/orch/pulls?state=open&head=chetwerikoff:orch/${number}`);
    const comments = prs[0] ? await this.pages(`repos/chetwerikoff/orch/issues/${prs[0].number}/comments`) : [];
    const backend = isCursor ? this.cursor(id, tree.path) : isClaude ? this.claude(id, tree.path) : this.v2(id, tree.path);
    this.workers.set(id, backend);
    await backend.create(model);
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
