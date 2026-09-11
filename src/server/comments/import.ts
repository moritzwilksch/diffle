import { ThreadCreateSchema } from '../../shared/protocol.js';
import type { CommentThread, ThreadCreate } from '../../shared/protocol.js';

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
  const result = ThreadCreateSchema.safeParse(entry);
  if (!result.success)
    throw new ImportError(
      `invalid comment${where}: ${result.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; ')}`,
    );
  return result.data;
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
