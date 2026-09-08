import { getFiletypeFromFileName } from '@pierre/diffs';
import { File, useWorkerPool } from '@pierre/diffs/react';
import type { ComponentProps } from 'react';
import { useEffect, useMemo, useState } from 'react';
import ReactMarkdown, { defaultUrlTransform } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { HighlightedCode } from './lsp/highlight.js';
import { useStore } from './store.js';

/**
 * Comment body as GitHub-flavored markdown. Raw HTML stays literal and images
 * are dropped: an agent-written body derives from repository content, which
 * must not make the reviewer's browser fetch a URL. A ```suggestion fence
 * becomes a labelled block, since agents and humans use it to propose
 * replacements for the quoted lines; `path` is the commented file, whose
 * extension picks the language the suggestion is highlighted in. With
 * `highlight`, every other fence is highlighted as its info string says (the
 * file's language when it says nothing), for language-server hover text.
 */
export function Markdown({ text, path, highlight = false }: { text: string; path?: string; highlight?: boolean }) {
  const components = useMemo(
    () => ({
      pre: (props: ComponentProps<'pre'> & { node?: unknown }) => <Pre {...props} path={path} highlight={highlight} />,
      a: Anchor,
    }),
    [path, highlight],
  );
  return (
    <div className="body markdown">
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={components} urlTransform={urlTransform} disallowedElements={['img']} unwrapDisallowed>
        {text}
      </ReactMarkdown>
    </div>
  );
}

function Pre({ children, node: _node, path, highlight, ...rest }: ComponentProps<'pre'> & { node?: unknown; path?: string; highlight?: boolean }) {
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
    const source = path ? textOf(props?.children).replace(/\n$/, '') : undefined;
    // A highlighted suggestion renders as a <div>: the File component's markup is not phrasing content.
    if (source != null)
      return (
        <div className="suggestion highlighted" title="Suggested replacement for the quoted lines">
          <span className="tag">Suggestion</span>
          <Highlighted path={path!} source={source} />
        </div>
      );
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
  const pool = useWorkerPool();
  const [primed, setPrimed] = useState(0);
  const file = useMemo(() => ({ name: path, contents: source, cacheKey: `suggestion:${path}:${source}` }), [path, source]);
  const options = useMemo(() => ({ themeType: theme, disableFileHeader: true, disableLineNumbers: true, overflow: 'wrap' as const }), [theme]);
  // The File component paints nothing until a highlight exists, so fill the pool's cache first and re-render on it.
  useEffect(() => {
    let live = true;
    void pool?.primeFileHighlightCache(file).then(() => live && setPrimed((n) => n + 1)).catch(() => {});
    return () => {
      live = false;
    };
  }, [pool, file, theme]);
  return <File key={`${theme}:${primed}`} file={file} options={options} />;
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
