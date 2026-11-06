import { Runner } from './runtime.ts';
import { parseStartArgs } from './start.ts';

if (Number(process.versions.node.split('.')[0]) !== 24) throw new Error('Runner requires Node 24.');
const [command, ...args] = process.argv.slice(2);
const runner = new Runner(process.cwd(), process.env);
try {
  if (command === 'tick' && (args.length === 0 || (args.length === 1 && args[0] === '--dry-run'))) {
    if (!await runner.tick(args.includes('--dry-run'))) process.exitCode = 1;
  }
  else if (command === 'start') {
    const { number, model } = parseStartArgs(args);
    await runner.start(number, model);
  }
  else throw new Error('Usage: node scripts/runner/cli.ts tick [--dry-run] | start <Issue number> [--model <providerID>/<modelID>[#<variant>]]');
} catch (error: any) {
  console.error(`runner: ${error.message}`);
  process.exitCode = 1;
}
