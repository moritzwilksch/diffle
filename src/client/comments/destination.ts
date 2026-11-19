export type CommentDestination = 'local' | 'github';

const DESTINATION_KEY = 'diffle.comment-destination';

export function readCommentDestination(): CommentDestination {
  try {
    return sessionStorage.getItem(DESTINATION_KEY) === 'github' ? 'github' : 'local';
  } catch {
    return 'local';
  }
}

export function rememberCommentDestination(destination: CommentDestination): void {
  try {
    sessionStorage.setItem(DESTINATION_KEY, destination);
  } catch {
    // The in-memory choice still works when browser storage is unavailable.
  }
}

const githubDraftIds = new WeakMap<object, string>();

/** Keep the same marker on retry so GitHub's pending review can deduplicate the draft. */
export function githubDraftId(draft: object): string {
  const existing = githubDraftIds.get(draft);
  if (existing) return existing;
  const id = Array.from(crypto.getRandomValues(new Uint8Array(16)), (byte) => byte.toString(16).padStart(2, '0')).join(
    '',
  );
  githubDraftIds.set(draft, id);
  return id;
}
