import { Runner } from './runtime.ts';

if (Number(process.versions.node.split('.')[0]) !== 24) throw new Error('Runner requires Node 24.');
const [command, ...args] = process.argv.slice(2);
const runner = new Runner(process.cwd(), process.env);
try {
  if (command === 'tick' && (args.length === 0 || (args.length === 1 && args[0] === '--dry-run'))) await runner.tick(args.includes('--dry-run'));
  else if (command === 'start' && args.length === 1 && /^[1-9]\d*$/.test(args[0]) && Number.isSafeInteger(Number(args[0]))) await runner.start(Number(args[0]));
  else throw new Error('Usage: node scripts/runner/cli.ts tick [--dry-run] | start <Issue number>');
} catch (error: any) {
  console.error(`runner: ${error.message}`);
  process.exitCode = 1;
}
