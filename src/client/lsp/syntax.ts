import { languageOf } from '../../shared/protocol.js';

export const GRAMMARS = {
  python: 'python',
  javascript: 'javascript',
  javascriptreact: 'javascript',
  typescript: 'typescript',
  typescriptreact: 'tsx',
  rust: 'rust',
  go: 'go',
  c: 'c',
  cpp: 'cpp',
  ruby: 'ruby',
  java: 'java',
  lua: 'lua',
  zig: 'zig',
  swift: 'swift',
  php: 'php',
  shellscript: 'bash',
  ocaml: 'ocaml',
} as const;

export function grammarOf(path: string): string | null {
  const language = languageOf(path);
  return language && language in GRAMMARS ? GRAMMARS[language as keyof typeof GRAMMARS] : null;
}

export interface SyntaxRequest {
  id: number;
  key: string;
  grammar: string;
  contents: string;
  line: number;
  col: number;
}

export interface SyntaxResponse {
  id: number;
  blocked: boolean;
}

let worker: Worker | null = null;
let unavailable = false;
let sequence = 0;
const pending = new Map<number, (blocked: boolean) => void>();

function stop(): void {
  unavailable = true;
  worker?.terminate();
  worker = null;
  for (const resolve of pending.values()) resolve(false);
  pending.clear();
}

/** Advisory syntax gate. Positions use 1-based lines and UTF-16 columns, like LSP targets. */
export async function blocksSymbol(
  path: string,
  side: string,
  line: number,
  col: number,
  contents: () => Promise<string>,
): Promise<boolean> {
  const grammar = grammarOf(path);
  if (!grammar || unavailable || typeof Worker === 'undefined') return false;
  try {
    const text = await contents();
    // Large files remain usable without copying and parsing them for an advisory popup.
    if (text.length > 1_000_000 || unavailable) return false;
    if (!worker) {
      worker = new Worker(new URL('./syntax.worker.ts', import.meta.url), { type: 'module' });
      worker.onmessage = ({ data }: MessageEvent<SyntaxResponse>) => {
        pending.get(data.id)?.(data.blocked);
        pending.delete(data.id);
      };
      worker.onerror = stop;
      worker.onmessageerror = stop;
    }
    const id = ++sequence;
    return await new Promise<boolean>((resolve) => {
      // A broken worker must not leave a click waiting indefinitely.
      const timer = setTimeout(stop, 5000);
      pending.set(id, (blocked) => {
        clearTimeout(timer);
        resolve(blocked);
      });
      try {
        worker!.postMessage({ id, key: `${side}:${path}`, grammar, contents: text, line, col } satisfies SyntaxRequest);
      } catch {
        stop();
      }
    });
  } catch {
    return false;
  }
}
