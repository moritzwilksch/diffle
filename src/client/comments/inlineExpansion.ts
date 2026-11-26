import { create } from 'zustand';

const initial = new Map<string, boolean>();
export const useInlineExpansion = create<{ expanded: ReadonlyMap<string, boolean> }>(() => ({ expanded: initial }));

export function setInlineExpanded(key: string, open: boolean, defaultOpen: boolean): void {
  useInlineExpansion.setState(({ expanded }) => {
    if ((expanded.get(key) ?? defaultOpen) === open) return { expanded };
    const next = new Map(expanded);
    if (open !== defaultOpen) next.set(key, open);
    else next.delete(key);
    return { expanded: next };
  });
}

export function resetInlineExpansion(): void {
  useInlineExpansion.setState({ expanded: initial });
}

export const localThreadKey = (id: string) => `local:${id}`;
export const githubThreadKey = (id: string) => `github:${id}`;
