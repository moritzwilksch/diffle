import { checkGate, FOLDER_CAP, LOC_CAP, type Finding } from './guards.js';
import { readGateInput } from './tree.js';

export interface GateResult {
  exitCode: 0 | 1;
  output: string;
}

function formatFinding(finding: Finding): string {
  switch (finding.guard) {
    case 'size':
      return [
        `quality gate: ${finding.path} is ${finding.lines} lines; the cap is ${LOC_CAP}.`,
        '  Move code into a module with its own responsibility, or list a cohesive unit',
        '  (generated code, a data catalog) in .locignore with a reason.',
      ].join('\n');
    case 'folder':
      return [
        `quality gate: ${finding.dir} holds ${finding.count} source files; the cap is ${FOLDER_CAP}.`,
        '  Group related files into a domain subfolder instead of adding another sibling,',
        '  or list a folder that must stay flat in .folderignore with a reason.',
      ].join('\n');
  }
}

/** Judges every file in the working tree of `cwd`; exit code 1 means the commit (or the CI job) fails. */
export function runGate(cwd: string): GateResult {
  const findings = checkGate(readGateInput(cwd));
  return { exitCode: findings.length === 0 ? 0 : 1, output: findings.map(formatFinding).join('\n') };
}
