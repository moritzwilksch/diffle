import type { CommentThread, Side, ThreadCreate } from '../../shared/protocol.js';

/** A payload that is not valid JSON or not a ThreadCreate. The caller's fault. */
export class ImportError extends Error {}

/** Everything `POST /api/threads` accepts: 1 MiB, like the HTTP body limit. */
const MAX_PAYLOAD_BYTES = 1024 * 1024;

/**
 * Parses `POST /api/threads` payloads: one object, or an array of them, as a
 * JSON string or an already-parsed value. Throws ImportError on any malformed
 * entry, naming its index.
 */
export function parseImports(raw: string | unknown): ThreadCreate[] {
  let value: unknown = raw;
  if (typeof raw === 'string') {
    if (Buffer.byteLength(raw) > MAX_PAYLOAD_BYTES) throw new ImportError('comment payload over 1 MiB');
    try {
      value = JSON.parse(raw);
    } catch (e) {
      throw new ImportError(`invalid comment JSON: ${(e as Error).message}`);
    }
  }
  const list = Array.isArray(value) ? value : [value];
  return list.map((entry, i) => toThreadCreate(entry, list.length > 1 ? `[${i}]` : ''));
}

function toThreadCreate(entry: unknown, where: string): ThreadCreate {
  const fail = (msg: string): never => {
    throw new ImportError(`invalid comment${where}: ${msg}`);
  };
  if (typeof entry !== 'object' || entry == null || Array.isArray(entry)) return fail('expected an object');
  const x = entry as Record<string, unknown>;
  if (typeof x.path !== 'string' || x.path === '') return fail('path required');
  if (typeof x.body !== 'string' || x.body.trim() === '') return fail('body required');
  if (!isLine(x.startLine)) return fail('startLine must be a positive integer');
  if (x.endLine != null && (!isLine(x.endLine) || x.endLine < x.startLine)) return fail('endLine must be an integer ≥ startLine');
  if (x.side != null && x.side !== 'old' && x.side !== 'new') return fail("side must be 'old' or 'new'");
  if (x.quoted != null && typeof x.quoted !== 'string') return fail('quoted must be a string');
  const t: ThreadCreate = { path: x.path, startLine: x.startLine, body: x.body };
  if (x.endLine != null) t.endLine = x.endLine as number;
  if (x.side != null) t.side = x.side as Side;
  if (x.quoted != null) t.quoted = x.quoted as string;
  return t;
}

function isLine(v: unknown): v is number {
  return typeof v === 'number' && Number.isInteger(v) && v >= 1;
}

/** True when `t` duplicates an open thread at the same anchor whose opening message has the same body. */
export function isDuplicate(existing: readonly CommentThread[], t: ThreadCreate): boolean {
  const side = t.side ?? 'new';
  const endLine = t.endLine ?? t.startLine;
  const body = t.body.trim();
  return existing.some(
    (e) =>
      !e.resolved &&
      e.anchor.path === t.path &&
      e.anchor.side === side &&
      e.anchor.startLine === t.startLine &&
      e.anchor.endLine === endLine &&
      e.messages[0]?.body.trim() === body,
  );
}
