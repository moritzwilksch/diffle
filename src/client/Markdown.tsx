import { getFiletypeFromFileName, parseDiffFromFile } from '@pierre/diffs';
import { File, FileDiff, useWorkerPool } from '@pierre/diffs/react';
import type { ComponentProps } from 'react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import ReactMarkdown, { defaultUrlTransform } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { HighlightedCode } from './lsp/highlight.js';
import { useStore } from './store.js';
import { SHIKI_THEMES } from './theme.js';

/**
 * Comment body as GitHub-flavored markdown. Raw HTML stays literal and images
 * are dropped: a body quotes repository content, which must not make the
 * reviewer's browser fetch a URL. A ```suggestion fence becomes a labelled
 * block proposing a replacement for `quoted`, the commented lines: with both
 * `path` and `quoted` it renders as a diff from them to the suggestion, with
 * only `path` as the suggested lines alone. `path`'s extension picks the
 * language either is highlighted in. With `highlight`, every other fence is
 * highlighted as its info string says (the file's language when it says
 * nothing), for language-server hover text.
 */
export function Markdown({
  text,
  path,
  quoted,
  highlight = false,
}: {
  text: string;
  path?: string;
  quoted?: string;
  highlight?: boolean;
}) {
  const components = useMemo(
    () => ({
      pre: (props: ComponentProps<'pre'> & { node?: unknown }) => (
        <Pre {...props} path={path} quoted={quoted} highlight={highlight} />
      ),
      a: Anchor,
    }),
    [path, quoted, highlight],
  );
  return (
    <div className="markdown">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={components}
        urlTransform={urlTransform}
        disallowedElements={['img']}
        unwrapDisallowed
      >
        {text}
      </ReactMarkdown>
    </div>
  );
}

function Pre({
  children,
  node: _node,
  path,
  quoted,
  highlight,
  ...rest
}: ComponentProps<'pre'> & { node?: unknown; path?: string; quoted?: string; highlight?: boolean }) {
  const theme = useStore((s) => s.theme);
  const code = Array.isArray(children) ? children[0] : children;
  const props = (code as { props?: { className?: string; children?: unknown } })?.props;
  const lang = /language-(\S+)/.exec(props?.className ?? '')?.[1];
  if (highlight && lang !== 'suggestion') {
    const as = lang ?? (path ? getFiletypeFromFileName(path) : undefined);
    if (as)
      return (
        <pre {...rest}>
          <code className={props?.className}>
            <HighlightedCode code={textOf(props?.children)} lang={as} theme={theme} />
          </code>
        </pre>
      );
  }
  if (lang === 'suggestion') {
    // A highlighted suggestion renders as a <div>: the File and FileDiff markup is not phrasing content.
    if (path != null) {
      const source = textOf(props?.children).replace(/\n$/, '');
      return (
        <div className="suggestion highlighted" title="Suggested replacement for the quoted lines">
          <span className="tag">Suggestion</span>
          {/* An unchanged suggestion diffs to nothing, so it shows as the lines it keeps. */}
          {quoted == null || (source !== '' && quoted === source) ? (
            <Highlighted path={path} source={source} />
          ) : (
            <SuggestedChange path={path} quoted={quoted} source={source} />
          )}
        </div>
      );
    }
    return (
      <pre {...rest} className="suggestion" title="Suggested replacement for the quoted lines">
        <span className="tag">Suggestion</span>
        {children}
      </pre>
    );
  }
  return <pre {...rest}>{children}</pre>;
}

/** The suggested lines rendered as a file, so they highlight like the source they replace. */
function Highlighted({ path, source }: { path: string; source: string }) {
  const theme = useStore((s) => s.theme);
  const file = useMemo(
    () => ({ name: path, contents: source, cacheKey: cacheKey('file', path, source) }),
    [path, source],
  );
  const options = useMemo(
    () => ({
      theme: SHIKI_THEMES,
      themeType: theme,
      disableFileHeader: true,
      disableLineNumbers: true,
      overflow: 'wrap' as const,
    }),
    [theme],
  );
  const prime = useCallback((pool: WorkerPool) => pool.primeFileHighlightCache(file), [file]);
  return <File key={usePrimed(prime)} file={file} options={options} />;
}

/** The quoted lines and their replacement as one unified diff, the way GitHub shows a suggested change. */
function SuggestedChange({ path, quoted, source }: { path: string; quoted: string; source: string }) {
  const theme = useStore((s) => s.theme);
  const fileDiff = useMemo(
    () =>
      parseDiffFromFile(
        // The quote spans at least one line, so an empty one is a blank line; an empty suggestion deletes.
        { name: path, contents: `${quoted}\n`, cacheKey: cacheKey('old', path, quoted) },
        { name: path, contents: source === '' ? '' : `${source}\n`, cacheKey: cacheKey('new', path, source) },
      ),
    [path, quoted, source],
  );
  const options = useMemo(
    () => ({
      theme: SHIKI_THEMES,
      themeType: theme,
      diffStyle: 'unified' as const,
      diffIndicators: 'classic' as const,
      // The diff spans only the quoted range: every line of it is worth showing, and numbering from 1 would lie.
      expandUnchanged: true,
      disableFileHeader: true,
      disableLineNumbers: true,
      overflow: 'wrap' as const,
    }),
    [theme],
  );
  const prime = useCallback((pool: WorkerPool) => pool.primeDiffHighlightCache(fileDiff), [fileDiff]);
  return <FileDiff key={usePrimed(prime)} fileDiff={fileDiff} options={options} />;
}

type WorkerPool = NonNullable<ReturnType<typeof useWorkerPool>>;

/**
 * A key that changes once `prime` has filled the pool's highlight cache: the File and FileDiff
 * components paint nothing until a highlight exists, so they remount on it.
 */
function usePrimed(prime: (pool: WorkerPool) => Promise<void>): string {
  const theme = useStore((s) => s.theme);
  const pool = useWorkerPool();
  const [primed, setPrimed] = useState(0);
  useEffect(() => {
    let live = true;
    if (pool)
      prime(pool)
        .then(() => live && setPrimed((n) => n + 1))
        .catch(() => {});
    return () => {
      live = false;
    };
  }, [pool, prime, theme]);
  return `${theme}:${primed}`;
}

/** JSON keeps the parts apart, so no two contents share a key, alone or joined into a diff's key. */
function cacheKey(...parts: string[]): string {
  return JSON.stringify(['suggestion', ...parts]);
}

function textOf(node: unknown): string {
  if (typeof node === 'string') return node;
  if (Array.isArray(node)) return node.map(textOf).join('');
  const child = (node as { props?: { children?: unknown } })?.props?.children;
  return child == null ? '' : textOf(child);
}

/** `diffle:<repo-relative path>#L<line>`, which the server writes for a `file:` link in hover text. */
const JUMP_LINK = /^diffle:([^#]*)(?:#L(\d+))?$/;

/** A `diffle:` link is an in-app jump, so it survives the default sanitizer, which keeps only http(s) and mailto. */
function urlTransform(url: string): string | null | undefined {
  return JUMP_LINK.test(url) ? url : defaultUrlTransform(url);
}

function Anchor({ node: _node, href, children, ...rest }: ComponentProps<'a'> & { node?: unknown }) {
  const jump = JUMP_LINK.exec(href ?? '');
  // Land it like gd does: following the hover text's "Go to X" must not cost the reader the diff they are in.
  if (jump)
    return (
      <a
        {...rest}
        href={href}
        onClick={(e) => {
          e.preventDefault();
          void useStore.getState().goToLink(decodeURI(jump[1]!), jump[2] == null ? undefined : Number(jump[2]));
        }}
      >
        {children}
      </a>
    );
  return (
    <a {...rest} href={href} target="_blank" rel="noreferrer">
      {children}
    </a>
  );
}
