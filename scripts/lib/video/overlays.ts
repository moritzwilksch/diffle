// Overlays for the demo videos: a pointer and the keys being pressed. Playwright's input is
// synthetic, so neither would appear in the recording otherwise. Both run in the page, so they are
// self-contained.

export function overlays(slow: number) {
  const KEY_NAMES: Record<string, string | null> = {
    Enter: '↵',
    Escape: 'esc',
    ArrowDown: '↓',
    ArrowUp: '↑',
    ' ': 'space',
    Control: null,
    Shift: null,
    Meta: null,
    Alt: null,
  };
  const install = () => {
    const style = document.createElement('style');
    style.textContent = `
      #demo-pointer { position: fixed; left: 0; top: 0; width: 22px; height: 22px; z-index: 2147483647;
        pointer-events: none; transform: translate(-100px, -100px);
        filter: drop-shadow(0 1px 2px rgb(0 0 0 / .45)); }
      #demo-pointer.down svg { transform: scale(.85); transform-origin: 3px 3px; }
      #demo-keys { position: fixed; left: 20px; bottom: 20px; z-index: 2147483647;
        pointer-events: none; display: flex; gap: 12px; }
      #demo-keys kbd { font: 800 44px/1 ui-monospace, monospace; display: inline-flex; align-items: center;
        justify-content: center; min-width: 60px; height: 60px; padding: 0 16px; border-radius: 14px;
        color: #fff; background: rgb(17 24 39 / .88); border: 1px solid rgb(255 255 255 / .18);
        box-shadow: 0 12px 36px rgb(0 0 0 / .35); transition: opacity .35s ease, transform .35s ease; }
      #demo-keys kbd.gone { opacity: 0; transform: translateY(6px); }
    `;
    document.documentElement.append(style);
    const pointer = document.createElement('div');
    pointer.id = 'demo-pointer';
    pointer.innerHTML = `<svg width="22" height="22" viewBox="0 0 24 24"><path d="M3 2.5v17.2l4.7-4.4 3 6.9 3.1-1.3-3-6.8h6.5z" fill="#fff" stroke="#111" stroke-width="1.4" stroke-linejoin="round"/></svg>`;
    const keys = document.createElement('div');
    keys.id = 'demo-keys';
    document.documentElement.append(pointer, keys);

    addEventListener(
      'mousemove',
      (e) => (pointer.style.transform = `translate(${e.clientX - 3}px, ${e.clientY - 2}px)`),
      true,
    );
    addEventListener('mousedown', () => pointer.classList.add('down'), true);
    addEventListener('mouseup', () => pointer.classList.remove('down'), true);

    let last: (HTMLElement & { timer?: ReturnType<typeof setTimeout> }) | null = null;
    let lastAt = 0;
    addEventListener(
      'keydown',
      (e) => {
        const target = e.composedPath()[0];
        const typing =
          target instanceof HTMLElement && (target.isContentEditable || /^(INPUT|TEXTAREA)$/.test(target.tagName));
        const combo = e.ctrlKey || e.metaKey;
        if (typing && !combo && e.key !== 'Escape') return;
        const name = KEY_NAMES[e.key] === undefined ? e.key : KEY_NAMES[e.key];
        if (name === null) return;
        const label = `${e.ctrlKey ? '⌃' : ''}${e.metaKey ? '⌘' : ''}${name}`;
        // Keys pressed in quick succession read as one sequence, like `yy` or `g/`.
        const now = performance.now();
        if (last && now - lastAt < 700 * slow && !last.classList.contains('gone')) last.textContent += ` ${label}`;
        else {
          last = document.createElement('kbd');
          last.textContent = label;
          keys.append(last);
          while (keys.children.length > 3) keys.firstElementChild?.remove();
        }
        lastAt = now;
        const shown = last;
        clearTimeout(shown.timer);
        shown.timer = setTimeout(() => {
          shown.classList.add('gone');
          setTimeout(() => shown.remove(), 400);
        }, 1100);
      },
      true,
    );
  };
  if (document.documentElement) install();
  else addEventListener('DOMContentLoaded', install);
}

/**
 * Stretch the page's timers by `slow`, as the animation playback rate stretches CSS animations, so
 * feedback a timer takes down (a toast, the check mark `yy` puts on the copy button) stays up as long in the
 * video as in diffle.
 */
export function slowTimers(slow: number) {
  const setTimeout = window.setTimeout;
  window.setTimeout = ((handler: TimerHandler, delay = 0, ...args: unknown[]) =>
    setTimeout(handler, delay * slow, ...args)) as typeof window.setTimeout;
}
