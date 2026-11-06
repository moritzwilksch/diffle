import { useEffect, useRef, useState } from 'react';
import { api } from '@/client/api.js';
import { kindGroup } from '@/client/lsp/symbolKind.js';
import type { GraphNode } from '@/shared/protocol.js';

/** What the language server says a node is. */
export interface Signature {
  /** The hover markdown, as the review's tooltip shows it; null when the server had nothing. */
  hover: string | null;
  /** For a type: its fields' hover signatures as one fenced block, since a class's own hover rarely lists them. */
  members: string | null;
}

/** Answers so far, by node id; a node still being asked is absent. */
export type Signatures = Map<string, Signature>;

/** Field, enum member and property kinds, plus methods for an interface, whose methods are its shape. */
const FIELD_KINDS = [7, 8, 22];
const INTERFACE = 11;
const METHOD = 6;
const MAX_MEMBERS = 16;

/**
 * Asks the language servers about each of `nodes`, once per node while `graph` stays the same; a
 * file-level node has no symbol to ask about.
 */
export function useSignatures(graph: unknown, nodes: GraphNode[]): Signatures {
  const cache = useRef({ graph, answers: new Map() as Signatures, asked: new Set<string>() });
  if (cache.current.graph !== graph) cache.current = { graph, answers: new Map(), asked: new Set() };
  const [, rerender] = useState(0);

  useEffect(() => {
    const current = cache.current;
    for (const n of nodes) {
      if (n.kind === 1 || current.asked.has(n.id)) continue;
      current.asked.add(n.id);
      void describe(n).then((s) => {
        current.answers.set(n.id, s);
        if (cache.current === current) rerender((x) => x + 1);
      });
    }
  }, [nodes]);
  return cache.current.answers;
}

async function describe(n: GraphNode): Promise<Signature> {
  const hover = await hoverAt(n);
  if (kindGroup(n.kind) !== 'type') return { hover, members: null };
  const outline = await api.lspSymbols({ path: n.path }).then(
    (r) => r.symbols,
    () => [],
  );
  const kinds = n.kind === INTERFACE ? [...FIELD_KINDS, METHOD] : FIELD_KINDS;
  // rust-analyzer's struct hover lists the fields already; pyrefly's class hover lists none.
  const shown = hover ? signatureOf(hover) : '';
  const members = outline
    .filter((s) => s.container === n.name && n.line < s.line && s.endLine <= n.endLine && kinds.includes(s.kind))
    .filter((s) => !new RegExp(`\\b${literal(s.name)}\\b`).test(shown))
    .slice(0, MAX_MEMBERS);
  const fences = (await Promise.all(members.map(hoverAt))).flatMap((h) => (h ? [fenceOf(h)] : []));
  if (!fences.length) return { hover, members: null };
  const body = fences.map((f) => f.code).join('\n');
  return { hover, members: `\`\`\`${fences[0]!.lang}\n${body}\n\`\`\`` };
}

function hoverAt(s: { path: string; line: number; col: number }): Promise<string | null> {
  return api.lspHover({ path: s.path, line: s.line, col: s.col, ownerOnly: true }).then(
    (r) => r.contents,
    () => null,
  );
}

const literal = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const FENCE = /```([^\n]*)\n([\s\S]*?)\n```/;

/**
 * The fenced blocks hover markdown opens with, which servers use for the signature: one in most,
 * two in rust-analyzer's, the module path and then the declaration.
 */
export function signatureOf(hover: string): string {
  const leading = /^(\s*```[^\n]*\n[\s\S]*?\n```)+/.exec(hover);
  return leading?.[0].trim() ?? hover;
}

/** The declaration in a member's hover: the last of its leading blocks, past rust-analyzer's path. */
function fenceOf(hover: string): { lang: string; code: string } {
  const m = [...signatureOf(hover).matchAll(new RegExp(FENCE, 'g'))].at(-1);
  return m ? { lang: m[1]!, code: m[2]! } : { lang: '', code: hover.trim() };
}
