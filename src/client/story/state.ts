import { create } from 'zustand';
import { api } from '@/client/api.js';
import { isViewed } from '@/client/model.js';
import { useStore, type ViewPlace } from '@/client/store.js';
import { showView, useViews } from '@/client/views/state.js';
import type { ChangedFile, Story, StoryPart, StoryState } from '@/shared/protocol.js';

export interface StoryViewState {
  /** The server's answer for `useStore().snapshot`; null until it comes, and again for a new snapshot. */
  state: StoryState | null;
  /** A request is out: the first load, or the one that starts the writing. */
  loading: boolean;
  /** The file under the reader's attention: keys act on it, and the tree names it. */
  cursor: string | null;
  /** Counts the moves, so moving onto the same file again scrolls to it again. */
  cursorSeq: number;
  /** Files whose diff the reader folded or unfolded here, apart from the diff view's folds. */
  folded: Record<string, boolean>;
  refresh(): Promise<void>;
  generate(): Promise<void>;
  /** Puts the cursor on `path`, scrolling it into view. */
  focus(path: string): void;
  /** Moves the cursor `delta` files along the story, or `delta` parts with `by: 'part'`. */
  move(delta: 1 | -1, by?: 'file' | 'part'): void;
  toggleFold(path: string): void;
  /** Marks the cursor's file viewed or not; with `part`, every file of its part. */
  toggleViewed(part?: boolean): Promise<void>;
  /** Leaves the story for the file under the cursor in the diff; Ctrl+o comes back. */
  open(): Promise<void>;
}

/** Every path of the story in reading order. */
export function storyPaths(story: Story): string[] {
  return story.parts.flatMap((p) => p.files.map((f) => f.path));
}

/** The story's part holding `path`. */
export function partOf(story: Story, path: string): StoryPart | undefined {
  return story.parts.find((p) => p.files.some((f) => f.path === path));
}

/** How many of `part`'s files are viewed, and the files themselves. */
export function partProgress(
  part: StoryPart,
  snapshot: { changed: ChangedFile[] },
  state: Parameters<typeof isViewed>[0],
): { files: ChangedFile[]; viewed: number } {
  const byPath = new Map(snapshot.changed.map((f) => [f.path, f]));
  const files = part.files.map((f) => byPath.get(f.path)).filter((f): f is ChangedFile => f != null);
  return { files, viewed: files.filter((f) => isViewed(state, f)).length };
}

let request = 0;

export const useStory = create<StoryViewState>((set, get) => {
  /** The story shown, if the server's answer is for the current snapshot and holds one. */
  const shown = (): Story | null => {
    const { state } = get();
    const snap = useStore.getState().snapshot;
    return state && snap && state.version === snap.version ? state.story : null;
  };
  return {
    state: null,
    loading: false,
    cursor: null,
    cursorSeq: 0,
    folded: {},

    async refresh() {
      const snap = useStore.getState().snapshot;
      if (!snap) return;
      const t = ++request;
      try {
        const state = await api.story();
        // An answer for another snapshot is outdated: the next `snapshot` message refreshes again.
        if (t === request && state.version === useStore.getState().snapshot?.version) set({ state, loading: false });
      } catch (e) {
        if (t === request) {
          set({ loading: false });
          useStore.getState().report('Loading the story', e);
        }
      }
    },

    async generate() {
      const snap = useStore.getState().snapshot;
      if (!snap || get().loading) return;
      const t = ++request;
      set({ loading: true });
      try {
        const state = await api.generateStory();
        if (t === request && state.version === useStore.getState().snapshot?.version) set({ state, loading: false });
        else if (t === request) set({ loading: false });
      } catch (e) {
        if (t === request) {
          set({ loading: false });
          useStore.getState().report('Writing the story', e);
        }
      }
    },

    focus(path) {
      set({ cursor: path, cursorSeq: get().cursorSeq + 1 });
      useStore.getState().selectFile(path);
    },

    move(delta, by = 'file') {
      const story = shown();
      if (!story) return;
      const paths = storyPaths(story);
      if (!paths.length) return;
      const { cursor } = get();
      let next: string | undefined;
      if (by === 'part') {
        const parts = story.parts.filter((p) => p.files.length > 0);
        const at = cursor ? parts.findIndex((p) => p.files.some((f) => f.path === cursor)) : -1;
        const part = parts[Math.max(0, Math.min(parts.length - 1, at + delta))];
        next = part?.files[0]?.path;
      } else {
        const at = cursor ? paths.indexOf(cursor) : -1;
        next =
          paths[at === -1 ? (delta > 0 ? 0 : paths.length - 1) : Math.max(0, Math.min(paths.length - 1, at + delta))];
      }
      if (next) get().focus(next);
    },

    toggleFold(path) {
      const review = useStore.getState();
      const folded = get().folded[path] ?? review.collapsed[path] ?? isFoldedByDefault(review, path);
      set({ folded: { ...get().folded, [path]: !folded } });
    },

    async toggleViewed(part = false) {
      const story = shown();
      const { cursor } = get();
      const review = useStore.getState();
      if (!story || !cursor || !review.snapshot) return;
      if (!part) {
        const file = review.snapshot.changed.find((f) => f.path === cursor);
        if (file) await review.setViewed(cursor, !isViewed(review, file));
        return;
      }
      const p = partOf(story, cursor);
      if (!p) return;
      const { files, viewed } = partProgress(p, review.snapshot, review);
      await review.setViewedMany(
        files.map((f) => f.path),
        viewed < files.length,
      );
    },

    async open() {
      const { cursor } = get();
      if (!cursor) return;
      await useStore.getState().goToLink(cursor);
      showView('diff');
    },
  };
});

/** A viewed or generated file starts folded, as in the diff view. */
export function isFoldedByDefault(
  review: Parameters<typeof isViewed>[0] & { snapshot: { changed: ChangedFile[] } | null },
  path: string,
): boolean {
  const file = review.snapshot?.changed.find((f) => f.path === path);
  return file ? isViewed(review, file) || file.generated : false;
}

export function storyPlace(): ViewPlace {
  const { cursor } = useStory.getState();
  return {
    view: `story:${cursor ?? ''}`,
    restore() {
      if (cursor) useStory.getState().focus(cursor);
      showView('story');
    },
  };
}

/** Whether the story view is the one shown. */
export function storyShown(): boolean {
  return useViews.getState().active === 'story';
}
