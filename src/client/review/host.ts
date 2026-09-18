/** The viewer element hosting `el`: its shadow root's host, or the nearest ancestor that owns a shadow root. */
export function hostOf(el: HTMLElement): HTMLElement | null {
  const root = el.getRootNode();
  if (root instanceof ShadowRoot) return root.host as HTMLElement;
  for (let p = el.parentElement; p; p = p.parentElement) if (p.shadowRoot) return p;
  return null;
}
