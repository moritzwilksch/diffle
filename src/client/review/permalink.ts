import type { CodeViewLineSelection } from '@pierre/diffs';
import { api } from '@/client/api.js';
import { copyText } from '@/client/clipboard.js';
import { pathFromItemId, selectionRange } from '@/client/model.js';
import { useStore, type ReviewState } from '@/client/store.js';
import type { Permalink, Snapshot } from '@/shared/protocol.js';

/** Asks the server for the link to a selection's lines in `snapshot`; it builds the forge's url. */
async function linkTo(
  s: ReviewState,
  snapshot: Snapshot,
  path: string,
  sel: CodeViewLineSelection,
): Promise<Permalink> {
  return api.permalink({ version: snapshot.version, path, ...selectionRange(s, path, sel) });
}

/**
 * The permalink to the draft's lines, asked afresh so a push since shows; null for a file draft,
 * lines the forge cannot show, or a failed lookup.
 */
export async function draftPermalink(s: ReviewState): Promise<string | null> {
  const d = s.draft;
  if (!s.snapshot || !d?.selection || s.fileView?.external) return null;
  const link = await linkTo(s, s.snapshot, d.path, d.selection).catch(() => null);
  return link?.url ?? null;
}

/** Copies the permalink to the cursor line or selection and says so, or says why there is none. */
export async function copyCursorPermalink(): Promise<void> {
  const s = useStore.getState();
  if (!s.snapshot || !s.selection) return s.flash('No line under the cursor');
  if (s.fileView?.external) return s.flash('Only repository files have GitHub links');
  const link = linkTo(s, s.snapshot, pathFromItemId(s.selection.id), s.selection);
  // The clipboard takes the pending url, so the write starts while the keypress still allows it.
  const copied = copyText(link.then((l) => l.url ?? Promise.reject(new Error(l.reason ?? 'No link'))));
  let resolved: Permalink;
  try {
    resolved = await link;
  } catch (e) {
    return s.report('Looking up the GitHub link', e);
  }
  if (!resolved.url) return s.flash(resolved.reason ?? 'No link');
  s.flash((await copied) ? 'Copied GitHub link' : 'The browser blocked clipboard access');
}
