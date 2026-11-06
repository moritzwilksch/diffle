import { useCallback, useEffect, useRef, useState } from 'react';

/** How long a copy button shows its check mark. */
const COPIED_MS = 1400;

/**
 * A copy button's acknowledgement: `copy` writes the text and, on success, sets `done` for a
 * moment; `acknowledge` sets it for a copy made elsewhere. A failed copy is the caller's to report.
 */
export function useCopied(): { done: boolean; copy(text: string): Promise<boolean>; acknowledge(): void } {
  const [done, setDone] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  const acknowledge = useCallback(() => {
    setDone(true);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setDone(false), COPIED_MS);
  }, []);
  const copy = useCallback(
    async (text: string) => {
      const ok = await copyText(text);
      if (ok) acknowledge();
      return ok;
    },
    [acknowledge],
  );
  return { done, copy, acknowledge };
}

/**
 * Copies text to the clipboard. `navigator.clipboard` only exists in secure
 * contexts (https or localhost); over plain http on a LAN address the legacy
 * `execCommand('copy')` path still works. Returns false when both fail, or
 * when a pending text rejects, so the caller can offer a manual-copy fallback.
 * Pass text still being fetched as a promise: the write then starts within the
 * user gesture, which Safari requires, instead of after an await.
 */
export async function copyText(text: string | Promise<string>): Promise<boolean> {
  if (navigator.clipboard && window.isSecureContext) {
    try {
      if (typeof text !== 'string' && typeof ClipboardItem !== 'undefined') {
        const blob = text.then((t) => new Blob([t], { type: 'text/plain' }));
        await navigator.clipboard.write([new ClipboardItem({ 'text/plain': blob })]);
      } else {
        await navigator.clipboard.writeText(await text);
      }
      return true;
    } catch {
      /* fall through */
    }
  }
  let value: string;
  try {
    value = await text;
  } catch {
    return false;
  }
  const ta = document.createElement('textarea');
  ta.value = value;
  ta.setAttribute('readonly', '');
  ta.style.position = 'fixed';
  ta.style.top = '0';
  ta.style.left = '0';
  ta.style.opacity = '0';
  document.body.appendChild(ta);
  ta.focus();
  ta.select();
  ta.setSelectionRange(0, value.length);
  let ok = false;
  try {
    ok = document.execCommand('copy');
  } catch {
    ok = false;
  }
  document.body.removeChild(ta);
  return ok;
}
