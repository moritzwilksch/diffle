import { getFiletypeFromFileName } from '@pierre/diffs';
import { FilePath } from '@/client/FilePath.js';
import { HighlightedCode } from '@/client/lsp/highlight.js';
import { useStore } from '@/client/store.js';
import { TourJump } from './Jump.js';

/**
 * Code the agent wrote, such as an interface or a signature, highlighted like the diff and in its
 * frame; with `path`, under the file's path, its line and a jump there.
 */
export function TourCode({ code, lang, path, line }: { code: string; lang?: string; path?: string; line?: number }) {
  const theme = useStore((s) => s.theme);
  const language = lang ?? (path ? getFiletypeFromFileName(path) : 'text');
  return (
    <figure className="tour-block mx-0 overflow-hidden rounded-md border border-border bg-canvas">
      {path && (
        <figcaption className="flex items-center gap-1.5 border-b border-border bg-surface px-2 py-1 text-[0.75rem]">
          <FilePath path={path} className="min-w-0 flex-1" nowrap />
          {line != null && <span className="shrink-0 font-mono text-muted">{line}</span>}
          <TourJump path={path} line={line} side="new" label="Open" placed />
        </figcaption>
      )}
      <pre className="m-0 overflow-x-auto bg-canvas px-3 py-2 font-mono text-[13px] leading-5">
        <HighlightedCode code={dedent(code)} lang={language} theme={theme} />
      </pre>
    </figure>
  );
}

/** `text` without the blank lines around it and the indentation its lines share, as the server reads it. */
export function dedent(text: string): string {
  const lines = text.split('\n');
  const first = lines.findIndex((l) => l.trim());
  if (first < 0) return '';
  const last = lines.findLastIndex((l) => l.trim());
  const body = lines.slice(first, last + 1);
  const indent = Math.min(...body.filter((l) => l.trim()).map((l) => l.length - l.trimStart().length));
  return body.map((l) => l.slice(indent).trimEnd()).join('\n');
}
