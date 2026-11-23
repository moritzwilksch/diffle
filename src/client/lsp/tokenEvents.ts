import type { DiffTokenEventBaseProps, TokenEventBase } from '@pierre/diffs';
import { useStore } from '@/client/store.js';
import { languageOf } from '@/shared/protocol.js';
import { hoverOnly, serversFor } from '@/shared/lsp.js';
import type { Side } from '@/shared/side.js';
import { hoverControl } from './HoverTooltip.js';
import { occurrenceControl } from './occurrences.js';
import { lspTarget, type TokenTarget } from './target.js';
import { charAtPoint } from './tokenText.js';
import { focusToken, wordsIn } from './wordNav.js';

export type TokenProps = TokenEventBase | DiffTokenEventBaseProps;

/**
 * Word under the pointer → LSP target; null on punctuation or space. Diff tokens carry a side; file items
 * are new-side only. A context line is the same text on both sides, so its old-side column resolves to the
 * new-side line.
 */
function targetOf(props: TokenProps, path: string, event: MouseEvent): TokenTarget | null {
  // No server for this language means no hover, no menu: a target would only produce blockers.
  if (!served(path)) return null;
  // A highlighter token can span several names (`a.b.c`, or a whole unhighlighted line); the pointer picks one.
  const word = wordAtPoint(
    props.tokenElement,
    event,
    hoverOnly(useStore.getState().lsp, useStore.getState().snapshot?.tree ?? [], path),
  );
  if (!word) return null;
  let side: Side = 'side' in props && props.side === 'deletions' ? 'old' : 'new';
  let line = props.lineNumber;
  if (side === 'old') {
    const row = props.tokenElement.closest<HTMLElement>('[data-line]');
    const alt = row?.dataset.lineType?.startsWith('context') ? Number(row.dataset.altLine) : NaN;
    if (Number.isFinite(alt)) {
      side = 'new';
      line = alt;
    }
  }
  return {
    path,
    side,
    line,
    col: props.lineCharStart + word.start,
    text: word.text,
  };
}

/** Whether some running language server claims this file's language. */
function served(path: string): boolean {
  const { lsp, snapshot } = useStore.getState();
  const language = languageOf(path, snapshot?.tree ?? []);
  return language != null && lsp.enabled && serversFor(lsp, language).length > 0;
}

/** The identifier under the pointer inside a token span: its text and its offset within the token, or null on punctuation or space. */
function wordAtPoint(el: HTMLElement, event: MouseEvent, config = false): { start: number; text: string } | null {
  const text = el.textContent ?? '';
  const at = charAtPoint(el, event.clientX, event.clientY);
  // Schema hovers describe keys and values, including quotes, hyphens, and numeric literals.
  if (config) return at >= 0 && /\S/.test(text[at]!) ? { start: at, text } : null;
  return wordsIn(text).find((word) => at >= word.start && at < word.start + word.text.length) ?? null;
}

/** Underline the hovered symbol while a modifier is held, like an editor's ctrl-hover. */
function markHover(el: HTMLElement, on: boolean): void {
  el.classList.toggle('lsp-hover', on);
}

/** The CSS for `markHover`'s underline, for the shadow root the tokens render in. */
export const LSP_HOVER_CSS = '.lsp-hover { text-decoration: underline; cursor: pointer; }';

/**
 * The viewer's token callbacks that put the diff's language-server actions on its symbols: the hover
 * card and the tint of its occurrences on rest, the symbol menu on click, the definition on
 * ⌘/Ctrl+click. `pathOf` names the file of the item a token is in. `keyboard` also hands a clicked
 * symbol to the keyboard's word focus, which only the review's own viewer tracks.
 */
export function tokenHandlers<C>(pathOf: (ctx: C) => string, keyboard = false) {
  // Stops following the pointer inside the hovered token; the viewer's leave for that token calls it.
  let untrack = () => {};
  return {
    onTokenEnter(props: TokenProps, event: PointerEvent, ctx: C): void {
      // The viewer reports one enter per token, but a token can hold several words (`a.b.c`): the pointer
      // moving from one to another inside it targets the new word as if it had crossed tokens. The leave
      // of the previous token already ran, so nothing is targeted when the pointer arrives.
      const path = pathOf(ctx);
      let shown: TokenTarget | null = null;
      const point = (e: PointerEvent) => {
        const t = targetOf(props, path, e);
        if (t?.col === shown?.col) return;
        shown = t;
        lspTarget.set(t, props.tokenElement);
        occurrenceControl.hover(t);
        if (t) hoverControl.enter(t, props.tokenElement);
        else hoverControl.leave();
        markHover(
          props.tokenElement,
          !!t &&
            !hoverOnly(useStore.getState().lsp, useStore.getState().snapshot?.tree ?? [], t.path) &&
            (e.ctrlKey || e.metaKey),
        );
      };
      point(event);
      props.tokenElement.addEventListener('pointermove', point);
      untrack = () => props.tokenElement.removeEventListener('pointermove', point);
    },
    onTokenLeave(props: TokenProps): void {
      untrack();
      untrack = () => {};
      lspTarget.set(null);
      occurrenceControl.hover(null);
      hoverControl.leave();
      markHover(props.tokenElement, false);
    },
    // A plain click on a symbol opens the action popover; ⌘/Ctrl+click jumps straight to the definition,
    // or lists references from the definition itself.
    onTokenClick(props: TokenProps, event: MouseEvent, ctx: C): void {
      const target = targetOf(props, pathOf(ctx), event);
      if (!target || hoverOnly(useStore.getState().lsp, useStore.getState().snapshot?.tree ?? [], target.path)) return;
      const store = useStore.getState();
      markHover(props.tokenElement, false);
      hoverControl.cancel();
      if (event.ctrlKey || event.metaKey) {
        event.preventDefault();
        void store.goToDefinition(target);
        return;
      }
      if (keyboard) focusToken(target, props.tokenElement);
      void store.openSymbolMenu(target, event.clientX, event.clientY);
    },
  };
}
