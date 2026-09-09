import { ChevronDown, ChevronRight, GitCommitHorizontal, GitPullRequest, History, PencilRuler } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import type { ModeRequest, RefsResponse } from '../../shared/protocol.js';
import { api } from '../api.js';
import { lastCommitsRequest } from '../model.js';
import { useStore } from '../store.js';
import { RefInput } from './RefInput.js';

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
  const [pr, setPr] = useState('');
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
  const count = Number(countText);
  const validCount = /^[0-9]+$/.test(countText) && Number.isSafeInteger(count) && count >= 1;
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
                if (pane === 'pr') choose(pr.trim() ? { kind: 'pr', pr: pr.trim() } : { kind: 'pr' });
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
                    <input
                      type="text"
                      inputMode="numeric"
                      pattern="[0-9]+"
                      aria-label="Number of commits"
                      aria-describedby="commit-count-hint"
                      aria-invalid={!validCount}
                      title="Number of commits (at least 1)"
                      autoFocus
                      onFocus={(e) => e.currentTarget.select()}
                      required
                      value={countText}
                      style={{ width: `${Math.max(1, countText.length)}ch` }}
                      onChange={(e) => {
                        const value = e.target.value;
                        if (/^[0-9]*$/.test(value)) setCountText(value);
                      }}
                    />
                    <span>..HEAD</span>
                  </div>
                  <p className="mode-hint" id="commit-count-hint">
                    Choose how many recent commits to compare.
                  </p>
                </div>
              )}
              {pane === 'pr' && (
                <>
                  <label className="ref-select">
                    <span className="lbl">PR number or URL</span>
                    <input value={pr} onChange={(e) => setPr(e.target.value)} placeholder="Current branch’s PR" />
                  </label>
                  <p className="mode-hint">Leave blank to review this branch’s pull request.</p>
                </>
              )}
              <button
                className="primary"
                type="submit"
                disabled={pane === 'refs' ? !a.trim() || !b.trim() : pane === 'commits' && !validCount}
              >
                Compare
              </button>
            </form>
          )}
        </div>
      )}
    </div>
  );
}
