export type WorkerModel = { providerID: string; id: string; variant?: string };
export const defaultWorkerModel: WorkerModel = { providerID: 'openai', id: 'gpt-6.1-sol', variant: 'medium' };
export const defaultMergeModel: WorkerModel = { providerID: 'openai', id: 'gpt-6-luna', variant: 'medium' };

export function parseStartArgs(args: string[]): { number: number; model: WorkerModel } {
  const usage = 'Usage: start <Issue number> [--model <providerID>/<modelID>[#<variant>]]';
  if (!/^[1-9]\d*$/.test(args[0] ?? '') || !Number.isSafeInteger(Number(args[0])) ||
      !(args.length === 1 || (args.length === 3 && args[1] === '--model'))) throw new Error(usage);
  if (args.length === 1) return { number: Number(args[0]), model: defaultWorkerModel };
  const match = /^([^\s/#]+)\/([^\s#]+)(?:#([^\s/#]+))?$/.exec(args[2]);
  if (!match) throw new Error(usage);
  if (match[1] === 'cursor' && match[3]) throw new Error('Cursor models do not accept #<variant>; put parameters inside the model ID.');
  return { number: Number(args[0]), model: { providerID: match[1], id: match[2], ...(match[3] ? { variant: match[3] } : {}) } };
}
