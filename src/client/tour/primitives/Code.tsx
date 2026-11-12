import { getFiletypeFromFileName } from '@pierre/diffs';
import { FilePath } from '@/client/FilePath.js';
import type { Place } from '@/client/tour/anchor.js';
import { useHost } from '@/client/tour/host/host.js';
import { TourJump } from './Jump.js';

/**
 * Code the agent wrote, such as an interface or a signature, in the diff's frame and rows: the same
 * gutter, numbered from `line` (else 1), and long lines wrapped. Code from the repository (`path`)
 * sits under a quiet header naming its file, its line and a jump there; an example the agent made up
 * says so in the same header, beside its title, so it never passes for the repository's code. Other
 * made-up code has no header.
 */
export function TourCode({
  code,
  lang,
  path,
  line,
  example = false,
  title,
  place,
}: {
  code: string;
  lang?: string;
  path?: string;
  line?: number;
  example?: boolean;
  title?: string;
  place?: Place;
}) {
  const { Rows } = useHost();
  return (
    <figure
      {...place}
      data-opaque=""
      className="tour-block mx-0 overflow-hidden rounded-md border border-border bg-canvas"
    >
      {(example || path) && (
        <figcaption className="tour-code-head">
          {example && <span className="tour-code-example">Example</span>}
          {title && <span className="min-w-0 truncate">{title}</span>}
          {path && <FilePath path={path} className="min-w-0 flex-1" nowrap />}
          {line != null && <span className="shrink-0 font-mono">{line}</span>}
          {path && <TourJump path={path} line={line} side="new" label="Open" placed />}
        </figcaption>
      )}
      <Rows patch={codePatch(code, line)} lang={codeLang(lang, path)} />
    </figure>
  );
}

/** `code` as the patch of one hunk whose lines are all unchanged, numbered from `start`. */
export function codePatch(code: string, start = 1): string {
  const lines = dedent(code).split('\n');
  const range = `${start},${lines.length}`;
  return `--- a/code\n+++ b/code\n@@ -${range} +${range} @@\n${lines.map((l) => ` ${l}`).join('\n')}\n`;
}

/** The language a code block is highlighted in: its `lang`, else its file's. */
export function codeLang(lang?: string, path?: string): string {
  return lang ?? (path ? getFiletypeFromFileName(path) : 'text');
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
