import type { ThemesType } from '@pierre/diffs';

export type ThemeChoice = 'system' | 'light' | 'dark';

/**
 * The Shiki themes the viewer, the markdown renderer and our own tokenizers all highlight with.
 * The app palette in `styles/theme.css` is derived from these two, so code and chrome share one look.
 */
export const SHIKI_THEMES: ThemesType = { light: 'github-light-high-contrast', dark: 'github-dark-high-contrast' };
const KEY = 'diffle:theme';

export function readTheme(): ThemeChoice {
  try {
    const v = localStorage.getItem(KEY);
    if (v === 'light' || v === 'dark' || v === 'system') return v;
  } catch {
    /* storage unavailable */
  }
  return 'system';
}

export function storeTheme(choice: ThemeChoice): void {
  try {
    localStorage.setItem(KEY, choice);
  } catch {
    /* ignore */
  }
}

/** Applies the choice to the document so our CSS, the tree, and the diff viewer agree. */
export function applyTheme(choice: ThemeChoice): void {
  const root = document.documentElement;
  if (choice === 'system') {
    delete root.dataset.theme;
    root.style.colorScheme = 'light dark';
  } else {
    root.dataset.theme = choice;
    root.style.colorScheme = choice;
  }
}

export function nextTheme(c: ThemeChoice): ThemeChoice {
  return c === 'system' ? 'light' : c === 'light' ? 'dark' : 'system';
}
