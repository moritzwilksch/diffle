/** Release archive name → the npm platform it serves. */
export const TARGETS: Record<string, { os: string; cpu: string }>;
/** Writes every package whose archive is present under `archives` into `out`. */
export function assemble(archives: string, out: string): { version: string; built: string[] };
/** Installs the launcher and this host's package into a temporary prefix and runs `diffle --version`; returns what it printed. */
export function smoke(out: string, version: string): string;
