interface Entry {
  restore(): void;
  previous?: string;
  next?: string;
}

const entries = new Map<string, Entry>();
const page = Math.random().toString(36).slice(2);
let nextId = 0;

/** Let the browser traverse symbol jumps without changing the URL or adding entries for cursor motion. */
export function rememberBrowserJump(origin: () => void, destination: () => void): boolean {
  if (typeof window === 'undefined') return false;
  const state = window.history.state;
  const current = typeof state?.diffleJump === 'string' ? entries.get(state.diffleJump) : undefined;
  const from = current ? state.diffleJump : `${page}/${nextId++}`;
  const to = `${page}/${nextId++}`;
  try {
    window.history.replaceState({ ...state, diffleJump: from }, '');
    window.history.pushState({ ...state, diffleJump: to }, '');
  } catch {
    // The in-app jumplist still works if the browser declines a history write.
    return false;
  }
  if (!entries.size) {
    window.addEventListener('popstate', (event) => entries.get(event.state?.diffleJump)?.restore());
  }
  let discarded = current?.next;
  while (discarded) {
    const next = entries.get(discarded)?.next;
    entries.delete(discarded);
    discarded = next;
  }
  entries.set(from, { restore: origin, previous: current?.previous, next: to });
  entries.set(to, { restore: destination, previous: from });
  return true;
}

export function stepBrowserJump(direction: -1 | 1): boolean {
  if (typeof window === 'undefined') return false;
  const entry = entries.get(window.history.state?.diffleJump);
  if (!(direction < 0 ? entry?.previous : entry?.next)) return false;
  window.history.go(direction);
  return true;
}
