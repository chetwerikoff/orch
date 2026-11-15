import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseTrains, trainBranchName, trainIsRed, trainRedAfter } from './train.ts';

const sha = (c: string) => c.repeat(40);
test('parseTrains reads main and exactly-shaped train branches', () => {
  const out = [
    `${sha('b')}\trefs/heads/main`,
    `${sha('c')}\trefs/heads/orch/train/bbbbbbb/2-1-7`,
    `${sha('d')}\trefs/heads/orch/train/zzzzzzz/1-2`,
    `${sha('e')}\trefs/heads/orch/train/bbbbbbb/1`,
    `${sha('f')}\trefs/heads/orch/train/bbbbbbb/1-2/x`,
    `${sha('a')}\trefs/heads/orch/1`,
  ].join('\n');
  const parsed = parseTrains(out);
  assert.equal(parsed.main, sha('b'));
  assert.equal(parsed.trains.length, 1);
  assert.deepEqual(parsed.trains[0], { name: 'orch/train/bbbbbbb/2-1-7', base7: 'bbbbbbb', members: [2, 1, 7], sha: sha('c') });
  assert.deepEqual(parseTrains(''), { main: undefined, trains: [] });
});
test('trainBranchName carries the base sha7 and ascending members', () => {
  assert.equal(trainBranchName(sha('b'), [5, 3, 10]), 'orch/train/bbbbbbb/3-5-10');
});
test('red is a failed check, or no green CI 30 minutes after the train commit', () => {
  const now = 60 * 60_000;
  assert.equal(trainIsRed('failure', now, now), true);
  assert.equal(trainIsRed('failure', 0, now), true);
  assert.equal(trainIsRed('pending', now - 60_000, now), false);
  assert.equal(trainIsRed('pending', now - trainRedAfter, now), false);
  assert.equal(trainIsRed('pending', now - trainRedAfter - 1, now), true);
  assert.equal(trainIsRed('success', 0, now), false);
});
