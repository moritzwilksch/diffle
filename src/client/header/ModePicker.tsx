import {
  ChevronDown,
  ChevronRight,
  ChevronUp,
  GitCommitHorizontal,
  GitPullRequest,
  History,
  PencilRuler,
} from 'lucide-react';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { ModeRequest, RefsResponse } from '../../shared/protocol.js';
import { api } from '../api.js';
import { lastCommitsRequest } from '../model.js';
import { useStore } from '../store.js';
import { RefInput } from './RefInput.js';
import { CommitPreview } from './CommitPreview.js';

/** Comparison modes with configuration in an adjacent pane. */
export function ModePicker() {
  const snapshot = useStore((s) => s.snapshot);
  const switchMode = useStore((s) => s.switchMode);
  const open = useStore((s) => s.modeMenuOpen);
  const setOpen = useStore((s) => s.setModeMenuOpen);
  const pane = useStore((s) => s.modePane);
  const pick = useStore((s) => s.pickModeEntry);
  const lastCommits = useStore((s) => s.lastCommits);
  const [refs, setRefs] = useState<RefsResponse | null>(null);
  const [a, setA] = useState('');
  const [b, setB] = useState('HEAD');
  const [dots, setDots] = useState<'..' | '...'>('..');
  const [countText, setCountText] = useState(String(lastCommits));
  const countInput = useRef<HTMLInputElement>(null);
  const selectCount = useRef(false);
  useLayoutEffect(() => {
    if (!selectCount.current) return;
    countInput.current?.focus();
    countInput.current?.select();
    selectCount.current = false;
  }, [countText]);
  const [pr, setPr] = useState('');
  const [prPending, setPrPending] = useState(false);
  const [prError, setPrError] = useState<string | null>(null);
  const prInFlight = useRef(false);
  const prView = useRef(0);
  const prInput = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const view = ++prView.current;
    return () => {
      prView.current = view + 1;
    };
  }, [open, pane]);

  const wrap = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
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
    trigger.current?.focus();
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
        trigger.current?.focus();
      } else if (typeof result === 'object') {
        setPrError(result.error);
        prInput.current?.focus();
      }
    } finally {
      prInFlight.current = false;
      setPrPending(false);
    }
  };
  const count = Number(countText);
  const validCount = /^[0-9]+$/.test(countText) && Number.isSafeInteger(count) && count >= 1;
  const stepCount = (delta: number) => {
    const next = String(Math.min(Number.MAX_SAFE_INTEGER, Math.max(1, (validCount ? count : 0) + delta)));
    selectCount.current = next !== countText;
    setCountText(next);
    countInput.current?.focus();
    countInput.current?.select();
  };
  const entries = [
    { label: 'Working', icon: PencilRuler, pane: null },
    { label: 'Two refs…', icon: GitCommitHorizontal, pane: 'refs' },
    { label: 'Last commits', icon: History, pane: 'commits' },
    { label: 'PR', icon: GitPullRequest, pane: 'pr' },
  ] as const;

  return (
    <div className="menu-wrap" ref={wrap}>
      <button
        ref={trigger}
        onClick={() => setOpen(!open)}
        title="Change what is compared (m)"
        aria-expanded={open}
        aria-controls="mode-picker"
        style={{ fontFamily: 'var(--mono)' }}
      >
        {snapshot?.mode.label ?? '…'} <ChevronDown size="0.875rem" />
      </button>
      {open && (
        <div className="menu mode-menu" id="mode-picker" role="dialog" aria-label="Compare">
          <div className="mode-entries">
            <div className="menu-title">Compare</div>
            {entries.map((entry, i) => (
              <button
                key={entry.label}
                className={`entry ${(entry.pane ? pane === entry.pane : !pane && snapshot?.mode.kind === 'working') ? 'active' : ''}`}
                aria-expanded={entry.pane ? pane === entry.pane : undefined}
                aria-controls={entry.pane ? 'mode-config' : undefined}
                onClick={() => pick(i + 1)}
              >
                <entry.icon size="0.875rem" />
                <span className="label">{entry.label}</span>
                <kbd>{i + 1}</kbd>
                {entry.pane ? <ChevronRight size="0.875rem" /> : <span />}
              </button>
            ))}
          </div>
          {pane && (
            <form
              className="mode-config"
              id="mode-config"
              aria-label={entries.find((e) => e.pane === pane)?.label}
              onSubmit={(e) => {
                e.preventDefault();
                if (pane === 'refs' && a.trim() && b.trim())
                  choose({ kind: 'revspec', args: [`${a.trim()}${dots}${b.trim()}`] });
                if (pane === 'commits' && validCount) {
                  useStore.getState().setLastCommits(count);
                  choose(lastCommitsRequest(count));
                }
                if (pane === 'pr') void openPr();
              }}
            >
              {pane === 'pr' && <div className="menu-title">Pull request</div>}
              {pane === 'refs' && (
                <>
                  <div className="ref-range">
                    <RefInput
                      label="Base ref"
                      value={a}
                      onChange={setA}
                      refs={refs}
                      autoFocus
                      onAccept={() => targetRef.current?.focus()}
                    />
                    <span>{dots}</span>
                    <RefInput
                      label="Target ref"
                      value={b}
                      onChange={setB}
                      refs={refs}
                      allowWorktree
                      inputRef={targetRef}
                      onAccept={() => comparisonToggle.current?.focus()}
                    />
                  </div>
                  <div
                    className="toggle ref-comparison"
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
                    <button
                      type="button"
                      className={dots === '..' ? 'on' : ''}
                      tabIndex={-1}
                      aria-pressed={dots === '..'}
                      onClick={() => setDots('..')}
                    >
                      Direct
                    </button>
                    <button
                      type="button"
                      className={dots === '...' ? 'on' : ''}
                      tabIndex={-1}
                      aria-pressed={dots === '...'}
                      onClick={() => setDots('...')}
                    >
                      Merge base
                    </button>
                  </div>
                  <p className="mode-hint">
                    {dots === '..' ? 'Compare these two revisions.' : 'Compare changes since their common ancestor.'}
                  </p>
                </>
              )}
              {pane === 'commits' && (
                <div className="commit-config">
                  <div className="commit-range">
                    <span>HEAD~</span>
                    <div className="commit-count">
                      <input
                        ref={countInput}
                        type="text"
                        inputMode="numeric"
                        pattern="[0-9]+"
                        aria-label="Number of commits"
                        aria-invalid={!validCount}
                        title="Number of commits (at least 1)"
                        autoFocus
                        onFocus={(e) => e.currentTarget.select()}
                        onKeyDown={(e) => {
                          if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return;
                          e.preventDefault();
                          e.stopPropagation();
                          stepCount(e.key === 'ArrowUp' ? 1 : -1);
                        }}
                        required
                        value={countText}
                        style={{ width: `${Math.max(1, countText.length)}ch` }}
                        onChange={(e) => {
                          const value = e.target.value;
                          if (/^[0-9]*$/.test(value)) setCountText(value);
                        }}
                      />
                      <div className="commit-count-buttons">
                        <button
                          type="button"
                          tabIndex={-1}
                          aria-label="Increase number of commits"
                          onMouseDown={(e) => e.preventDefault()}
                          onClick={() => stepCount(1)}
                        >
                          <ChevronUp size="0.625rem" />
                        </button>
                        <button
                          type="button"
                          tabIndex={-1}
                          aria-label="Decrease number of commits"
                          onMouseDown={(e) => e.preventDefault()}
                          onClick={() => stepCount(-1)}
                        >
                          <ChevronDown size="0.625rem" />
                        </button>
                      </div>
                    </div>
                    <span>..HEAD</span>
                  </div>
                  <CommitPreview count={validCount ? count : null} version={snapshot?.version ?? 0} />
                </div>
              )}
              {pane === 'pr' && (
                <>
                  <label className="ref-select">
                    <span className="lbl">PR number or URL</span>
                    <input
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
                  <p className="mode-hint" id="pr-hint">
                    Enter a PR number or URL, or leave blank for this branch.
                  </p>
                  {prError && (
                    <p className="mode-error" id="pr-error" role="alert">
                      {prError}
                    </p>
                  )}
                </>
              )}
              <button
                className="primary"
                type="submit"
                aria-live={pane === 'pr' ? 'polite' : undefined}
                aria-busy={pane === 'pr' && prPending}
                disabled={pane === 'pr' ? prPending : pane === 'refs' ? !a.trim() || !b.trim() : !validCount}
              >
                {pane === 'pr' ? (prPending ? 'Opening PR…' : 'Open PR') : 'Compare'}
              </button>
            </form>
          )}
        </div>
      )}
    </div>
  );
}
