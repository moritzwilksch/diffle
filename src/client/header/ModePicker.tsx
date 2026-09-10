import { ToggleButton } from '../ui/ToggleButton.js';
import { twMerge } from 'tailwind-merge';
import { Button } from '../ui/Button.js';
import {
  ArrowLeftRight,
  ChevronDown,
  ChevronRight,
  GitCommitHorizontal,
  GitPullRequest,
  History,
  PencilRuler,
} from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import type { ModeRequest, RefsResponse } from '../../shared/protocol.js';
import { api } from '../api.js';
import { focusReview } from '../keyboard/useKeymap.js';
import { lastCommitsRequest } from '../model.js';
import { useStore } from '../store.js';
import { RefInput } from './RefInput.js';
import { CommitOffsetInput, parseOffset } from './CommitOffsetInput.js';
import { CommitPreview } from './CommitPreview.js';

/** Comparison modes with configuration in an adjacent pane. */
export function ModePicker() {
  const snapshot = useStore((s) => s.snapshot);
  const switchMode = useStore((s) => s.switchMode);
  const open = useStore((s) => s.modeMenuOpen);
  const setOpen = useStore((s) => s.setModeMenuOpen);
  const pane = useStore((s) => s.modePane);
  const pick = useStore((s) => s.pickModeEntry);
  const [refs, setRefs] = useState<RefsResponse | null>(null);
  const [a, setA] = useState('');
  const [b, setB] = useState('HEAD');
  const [dots, setDots] = useState<'..' | '...'>('..');
  const [oldOffsetText, setOldOffsetText] = useState('1');
  const [newOffsetText, setNewOffsetText] = useState('0');
  const [pr, setPr] = useState('');
  const [prPending, setPrPending] = useState(false);
  const [prError, setPrError] = useState<string | null>(null);
  const prInFlight = useRef(false);
  const prView = useRef(0);
  const prInput = useRef<HTMLInputElement>(null);
  const pointerPick = useRef(false);

  useEffect(() => {
    pointerPick.current = false;
  }, [open, pane]);

  useEffect(() => {
    const view = ++prView.current;
    return () => {
      prView.current = view + 1;
    };
  }, [open, pane]);

  const wrap = useRef<HTMLDivElement>(null);
  const targetRef = useRef<HTMLInputElement>(null);
  const comparisonToggle = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    let current = true;
    void api
      .refs()
      .then((r) => {
        if (!current) return;
        setRefs(r);
        setA((cur) => cur || r.defaultBranch || r.branches[0] || 'HEAD');
      })
      .catch((e) => {
        if (current) useStore.getState().report('Loading refs', e);
      });
    const onDoc = (e: MouseEvent) => {
      if (!wrap.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDoc);
    return () => {
      current = false;
      document.removeEventListener('mousedown', onDoc);
    };
  }, [open, setOpen]);

  const choose = (req: ModeRequest) => {
    setOpen(false);
    // Hand focus back to the diff instead of the trigger: a programmatic focus there shows the
    // native ring even though the user never navigated to the button.
    focusReview();
    void switchMode(req);
  };
  const openPr = async () => {
    if (prInFlight.current) return;
    prInFlight.current = true;
    setPrPending(true);
    setPrError(null);
    const view = prView.current;
    try {
      const result = await switchMode(pr.trim() ? { kind: 'pr', pr: pr.trim() } : { kind: 'pr' });
      if (view !== prView.current) return;
      if (result === 'applied') {
        setOpen(false);
        focusReview();
      } else if (typeof result === 'object') {
        setPrError(result.error);
        prInput.current?.focus();
      }
    } finally {
      prInFlight.current = false;
      setPrPending(false);
    }
  };
  const oldOffset = parseOffset(oldOffsetText);
  const newOffset = parseOffset(newOffsetText);
  const validOffsets = oldOffset !== null && newOffset !== null;
  const swapRefs = () => {
    setA(b);
    setB(a);
  };
  const entries = [
    { label: 'Working', icon: PencilRuler, pane: null },
    { label: 'Two refs…', icon: GitCommitHorizontal, pane: 'refs' },
    { label: 'Last commits', icon: History, pane: 'commits' },
    { label: 'PR', icon: GitPullRequest, pane: 'pr' },
  ] as const;

  return (
    <div className="relative" ref={wrap}>
      <Button
        onClick={() => setOpen(!open)}
        title="Change what is compared (m)"
        aria-expanded={open}
        aria-controls="mode-picker"
        className="font-mono"
      >
        {snapshot?.mode.label ?? '…'} <ChevronDown size="0.875rem" />
      </Button>
      {open && (
        <div
          className="absolute top-[calc(100%_+_0.375rem)] left-0 z-20 flex w-max max-w-[calc(100vw_-_2rem)] min-w-60 rounded-[0.625rem] border border-border bg-canvas p-1.5 shadow-[0_0.625rem_1.875rem_rgba(0,_0,_0,_0.18)] max-[640px]:fixed max-[640px]:top-12 max-[640px]:left-2 max-[640px]:max-w-[calc(100vw_-_1rem)]"
          id="mode-picker"
          role="dialog"
          aria-label="Compare"
        >
          <div className="w-60 shrink-0 max-[640px]:w-44">
            <div className="px-2.5 pt-1 pb-1.5 text-[0.6875rem] font-semibold text-muted">Compare</div>
            {entries.map((entry, i) => (
              <Button
                key={entry.label}
                className={twMerge(
                  `grid min-h-8.5 w-full grid-cols-[1.125rem_1fr_auto_1.5rem] items-center gap-2.5 rounded-[0.4375rem] border-0 bg-transparent px-2.5 py-1.75 text-left font-sans text-[0.8125rem] leading-[1.3] text-foreground hover:bg-hover [&_kbd]:ml-1 [&_kbd]:justify-self-end [&_kbd]:text-muted [&>svg]:text-muted ${pane === entry.pane ? '[&>span:first-of-type]:font-semibold [&>svg]:text-accent' : ''}`,
                )}
                aria-expanded={entry.pane ? pane === entry.pane : undefined}
                aria-controls={entry.pane ? 'mode-config' : undefined}
                onClick={(e) => {
                  pointerPick.current = e.detail > 0;
                  pick(i + 1);
                }}
              >
                <entry.icon size="0.875rem" />
                <span className="whitespace-nowrap">{entry.label}</span>
                <kbd>{i + 1}</kbd>
                {entry.pane ? <ChevronRight size="0.875rem" /> : <span />}
              </Button>
            ))}
          </div>
          {pane && (
            <form
              className="ml-1.5 flex w-76 min-w-0 flex-col gap-3 border-l border-l-border px-3 pt-0 pb-2"
              id="mode-config"
              aria-label={entries.find((e) => e.pane === pane)?.label}
              onKeyDown={(e) => {
                if (pane !== 'refs' || e.key !== 'x' || e.ctrlKey || e.metaKey || e.altKey) return;
                if ((e.target as HTMLElement).closest('input, textarea, select, [contenteditable]')) return;
                e.preventDefault();
                e.stopPropagation();
                if (!e.repeat) swapRefs();
              }}
              onSubmit={(e) => {
                e.preventDefault();
                if (pane === 'refs' && a.trim() && b.trim())
                  choose({ kind: 'revspec', args: [`${a.trim()}${dots}${b.trim()}`] });
                if (pane === 'commits' && validOffsets) {
                  choose(lastCommitsRequest(oldOffset, newOffset));
                }
                if (pane === 'pr') void openPr();
              }}
            >
              {pane === 'pr' && (
                <div className="pt-1 pb-1.5 text-[0.6875rem] font-semibold text-muted">Pull request</div>
              )}
              {pane === 'refs' && (
                <>
                  <div className="flex items-center gap-1.5 pt-1.5 font-mono text-[0.8125rem] leading-[1.5]">
                    <RefInput
                      label="Base ref"
                      value={a}
                      onChange={setA}
                      refs={refs}
                      autoFocus={!pointerPick.current}
                      onAccept={() => targetRef.current?.focus()}
                    />
                    <span>{dots}</span>
                    <RefInput
                      label="Target ref"
                      value={b}
                      onChange={setB}
                      refs={refs}
                      inputRef={targetRef}
                      onAccept={() => comparisonToggle.current?.focus()}
                    />
                  </div>
                  <div className="flex items-center gap-2">
                    <div
                      className="flex self-start overflow-hidden rounded-md border border-border focus-visible:outline-2 focus-visible:outline-offset-[2px] focus-visible:outline-accent focus-visible:outline-solid"
                      ref={comparisonToggle}
                      role="group"
                      aria-label={`Comparison: ${dots === '..' ? 'Direct' : 'Merge base'}. Space to toggle.`}
                      tabIndex={0}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') {
                          e.preventDefault();
                          e.stopPropagation();
                          if (!e.repeat) e.currentTarget.closest('form')?.requestSubmit();
                          return;
                        }
                        if (e.key !== ' ') return;
                        e.preventDefault();
                        e.stopPropagation();
                        if (!e.repeat) setDots((current) => (current === '..' ? '...' : '..'));
                      }}
                    >
                      <ToggleButton type="button" selected={dots === '..'} tabIndex={-1} onClick={() => setDots('..')}>
                        Direct
                      </ToggleButton>
                      <ToggleButton
                        type="button"
                        selected={dots === '...'}
                        tabIndex={-1}
                        onClick={() => setDots('...')}
                      >
                        Merge base
                      </ToggleButton>
                    </div>
                    <Button
                      id="swap-refs"
                      className="border-0 bg-transparent p-0.5 text-muted hover:bg-hover hover:text-foreground"
                      type="button"
                      tabIndex={-1}
                      aria-label="Swap refs"
                      aria-keyshortcuts="x"
                      title="Swap refs (x)"
                      onClick={swapRefs}
                    >
                      <ArrowLeftRight size="0.75rem" />
                    </Button>
                  </div>
                  <p className="m-0 p-0 text-[0.75rem] whitespace-normal text-muted">
                    {dots === '..' ? 'Compare these two revisions.' : 'Compare changes since their common ancestor.'}
                  </p>
                </>
              )}
              {pane === 'commits' && (
                <div className="flex flex-col gap-2 pt-1.5">
                  <div className="flex items-baseline font-mono text-[0.8125rem] leading-[1.5]">
                    <span>HEAD~</span>
                    <CommitOffsetInput
                      label="Base offset"
                      value={oldOffsetText}
                      onChange={setOldOffsetText}
                      autoFocus
                    />
                    <span>..HEAD~</span>
                    <CommitOffsetInput label="Target offset" value={newOffsetText} onChange={setNewOffsetText} />
                  </div>
                  <CommitPreview oldOffset={oldOffset} newOffset={newOffset} version={snapshot?.version ?? 0} />
                </div>
              )}
              {pane === 'pr' && (
                <>
                  <label className="flex min-w-0 flex-col gap-1.5">
                    <span className="text-[0.75rem] text-muted">PR number or URL</span>
                    <input
                      className="w-full min-w-0 rounded-md border border-border bg-surface px-2 py-1.5 font-mono text-[0.75rem] leading-[normal] text-foreground"
                      ref={prInput}
                      autoFocus
                      autoComplete="off"
                      spellCheck={false}
                      readOnly={prPending}
                      aria-describedby={prError ? 'pr-hint pr-error' : 'pr-hint'}
                      aria-invalid={prError ? true : undefined}
                      value={pr}
                      onChange={(e) => {
                        setPr(e.target.value);
                        setPrError(null);
                      }}
                      placeholder="Current branch’s PR"
                    />
                  </label>
                  <p className="m-0 p-0 text-[0.75rem] whitespace-normal text-muted" id="pr-hint">
                    Enter a PR number or URL, or leave blank for this branch.
                  </p>
                  {prError && (
                    <p className="m-0 text-[0.75rem] wrap-anywhere text-del" id="pr-error" role="alert">
                      {prError}
                    </p>
                  )}
                </>
              )}
              <Button
                className="mt-auto self-end"
                variant="primary"
                type="submit"
                aria-live={pane === 'pr' ? 'polite' : undefined}
                aria-busy={pane === 'pr' && prPending}
                disabled={pane === 'pr' ? prPending : pane === 'refs' ? !a.trim() || !b.trim() : !validOffsets}
              >
                {pane === 'pr' ? (prPending ? 'Loading PR…' : 'Show PR') : 'Compare'}
              </Button>
            </form>
          )}
        </div>
      )}
    </div>
  );
}
