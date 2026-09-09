import type { CommentMessage, CommentThread } from '../../shared/protocol.js';
import { compareThreads } from './anchor.js';

/**
 * Agent-prompt format, one block per thread:
 *
 *   path:line            (or path:start-end)
 *
 *   > quoted line
 *
 *   body                 (a thread's messages joined by a blank line)
 *
 *   ---
 *
 * A ```suggestion fence in a body expands to ORIGINAL / SUGGESTED fences.
 */
export function formatPrompt(threads: CommentThread[]): string {
  return [...threads].sort(compareThreads).map(formatOne).join('\n');
}

function formatOne(t: CommentThread): string {
  const { anchor } = t;
  const range = anchor.startLine === anchor.endLine ? `${anchor.startLine}` : `${anchor.startLine}-${anchor.endLine}`;
  const prefixes: string[] = [];
  if (anchor.side === 'old') prefixes.push('(removed)');
  if (t.stale) prefixes.push(`(stale, was line ${t.staleFromLine ?? anchor.startLine})`);
  const header = `${prefixes.length ? prefixes.join(' ') + ' ' : ''}${anchor.path}:${range}`;
  const quote = anchor.quoted
    .split('\n')
    .map((l) => (l.length ? `> ${l}` : '>'))
    .join('\n');
  const body = t.messages.map((m) => formatMessage(m, anchor.quoted)).join('\n\n');
  return `${header}\n\n${quote}\n\n${body}\n\n---\n`;
}

function formatMessage(m: CommentMessage, quoted: string): string {
  return parseSuggestions(m.body)
    .map((seg) => (seg.code == null ? seg.text.trim() : renderSuggestion(quoted, seg.code)))
    .filter((s) => s.length > 0)
    .join('\n\n');
}

function renderSuggestion(original: string, code: string): string {
  return `ORIGINAL:\n\`\`\`\n${original}\n\`\`\`\nSUGGESTED:\n\`\`\`\n${code}\n\`\`\``;
}

interface BodySegment {
  /** Prose before or between suggestions; may be empty. */
  text: string;
  /** Replacement code for the quoted range, when the segment is a ```suggestion fence. */
  code?: string;
}

const SUGGESTION_FENCE = /^```suggestion[^\n]*\n([\s\S]*?)\n?^```[ \t]*$/gm;

/** Splits a body into prose and ```suggestion``` blocks, in order. Plain text yields one segment. */
export function parseSuggestions(body: string): BodySegment[] {
  const out: BodySegment[] = [];
  let last = 0;
  for (const m of body.matchAll(SUGGESTION_FENCE)) {
    const before = body.slice(last, m.index);
    if (before.trim()) out.push({ text: before });
    out.push({ text: '', code: m[1] ?? '' });
    last = m.index + m[0].length;
  }
  const rest = body.slice(last);
  if (rest.trim() || out.length === 0) out.push({ text: rest });
  return out;
}
