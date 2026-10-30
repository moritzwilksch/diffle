import { BookOpenText } from 'lucide-react';
import { CommentPanel } from '@/client/comments/CommentPanel.js';
import type { ViewDef } from '@/client/views/state.js';
import { STORY_HELP } from './help.js';
import { storyPlace, useStory } from './state.js';
import { StoryPane } from './StoryPane.js';

/** Keys the review keeps while the story shows: help, theme, the view switch, the jump list. */
const STORY_PASSES: ReadonlySet<string> = new Set(['?', 't', 'm', 'M', 'S', 'o']);

/** The review as a story: its changed files in parts a reader follows in order, told by a model. */
export const storyView: ViewDef = {
  id: 'story',
  label: 'Story',
  icon: BookOpenText,
  title: 'The changes told as a story (S)',
  Main: StoryPane,
  Side: CommentPanel,
  help: STORY_HELP,
  panelLabel: 'comments panel',
  panelWidth: '21.25rem',
  blocked: (s) => (s.snapshot && s.snapshot.changed.length === 0 ? 'No changes to tell' : null),
  place: storyPlace,
  keys: storyKeys,
  passes: STORY_PASSES,
  pickFile: (path) => useStory.getState().focus(path),
};

function storyKeys(e: KeyboardEvent): boolean {
  const story = useStory.getState();
  switch (e.key) {
    case 'j':
    case 'ArrowDown':
      story.move(1);
      return true;
    case 'k':
    case 'ArrowUp':
      story.move(-1);
      return true;
    case 'n':
      story.move(1, 'part');
      return true;
    case 'p':
      story.move(-1, 'part');
      return true;
    case 'Enter':
      void story.open();
      return true;
    case 'v':
      void story.toggleViewed();
      return true;
    case 'V':
      void story.toggleViewed(true);
      return true;
    case 'z':
      if (story.cursor) story.toggleFold(story.cursor);
      return true;
    case 'r':
      void story.generate();
      return true;
    default:
      return false;
  }
}
