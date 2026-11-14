import type { Facts } from './decide.ts';

// Branch names are the only train state: orch/train/<main sha7>/<n1>-<n2>-...
export type TrainRef = { name: string; base7: string; members: number[]; sha: string };
export type TrainRefs = { main?: string; trains: TrainRef[] };

export function parseTrains(output: string): TrainRefs {
  let main: string | undefined;
  const trains: TrainRef[] = [];
  for (const line of output.trim().split('\n')) {
    const [sha, ref] = line.split('\t');
    if (!/^[0-9a-f]{40}$/.test(sha ?? '') || !ref) continue;
    if (ref === 'refs/heads/main') main = sha;
    const train = /^refs\/heads\/(orch\/train\/([0-9a-f]{7})\/([1-9]\d*(?:-[1-9]\d*)+))$/.exec(ref);
    if (train) trains.push({ name: train[1], base7: train[2], members: train[3].split('-').map(Number), sha });
  }
  return { main, trains };
}

export function trainBranchName(mainSha: string, members: number[]): string {
  return `orch/train/${mainSha.slice(0, 7)}/${[...members].sort((a, b) => a - b).join('-')}`;
}

// CI is one job; zero check runs must not stay pending forever.
export const trainRedAfter = 30 * 60_000;
export function trainIsRed(ci: Facts['ci'], commitTime: number, now: number): boolean {
  if (ci === 'failure') return true;
  return ci !== 'success' && now - commitTime > trainRedAfter;
}
