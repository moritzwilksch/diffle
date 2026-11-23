export const githubCommentsEvent = 'diffle:github-comments';

export function githubCommentsChanged<T>(value: T): T {
  window.dispatchEvent(new Event(githubCommentsEvent));
  return value;
}
