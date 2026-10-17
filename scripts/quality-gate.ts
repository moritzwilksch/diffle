import { runGate } from './lib/quality-gate/run.js';

const { exitCode, output } = runGate(process.cwd());
if (output) console.error(output);
process.exit(exitCode);
