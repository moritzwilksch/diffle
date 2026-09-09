import {
  ChevronDown,
  ChevronUp,
  GitBranch,
  GitCommitHorizontal,
  GitPullRequest,
  History,
  PencilRuler,
} from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import type { ModeRequest, RefsResponse } from '../../shared/protocol.js';
import { api } from '../api.js';
import { lastCommitsRequest } from '../model.js';
import { useStore } from '../store.js';

/**
 * Mode dropdown, ordered by how often a reviewer needs each:
 * PR · branch vs base · working · last N commits · two refs.
 */
export function ModePicker() {
  const snapshot = useStore((s) => s.snapshot);
  const switchMode = useStore((s) => s.switchMode);
  const open = useStore((s) => s.modeMenuOpen);
  const setOpen = useStore((s) => s.setModeMenuOpen);
  const twoRefsRequested = useStore((s) => s.twoRefsOpen);
  const setTwoRefsOpen = useStore((s) => s.setTwoRefsOpen);
  const lastCommits = useStore((s) => s.lastCommits);
  const setLastCommits = useStore((s) => s.setLastCommits);
  const [refs, setRefs] = useState<RefsResponse | null>(null);
  const [base, setBase] = useState('');
  const [twoRefs, setTwoRefs] = useState(false);
  const [a, setA] = useState('');
  const [b, setB] = useState('HEAD');
  const [dots, setDots] = useState<'..' | '...'>('...');
  // Text mirror of lastCommits so the field can be emptied while retyping.
  const [countText, setCountText] = useState(String(lastCommits));
  const wrap = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (twoRefsRequested) {
      setTwoRefs(true);
      setTwoRefsOpen(false);
    }
  }, [twoRefsRequested, setTwoRefsOpen]);

  useEffect(() => {
    if (!open) return;
    void api.refs().then((r) => {
      setRefs(r);
      setBase((cur) => cur || r.defaultBranch || r.branches[0] || '');
      setA((cur) => cur || r.defaultBranch || '');
    });
    const onDoc = (e: MouseEvent) => {
      if (!wrap.current?.contains(e.target as Node)) useStore.getState().setModeMenuOpen(false);
    };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [open, setOpen]);

  const choose = (req: ModeRequest) => {
    setOpen(false);
    setTwoRefs(false);
    void switchMode(req);
  };

  const kind = snapshot?.mode.kind;
  const label = snapshot?.mode.label ?? '…';
  const refOptions = refs ? [...refs.branches, ...refs.remoteBranches, ...refs.tags] : [];

  return (
    <div className="menu-wrap" ref={wrap}>
      <button onClick={() => setOpen(!open)} title="Change what is compared (m)" style={{ fontFamily: 'var(--mono)' }}>
        {label} <ChevronDown size="0.875rem" />
      </button>
      {open && (
        <div className="menu mode-menu" role="menu">
          <div className="menu-title">Compare</div>
          <button className={`entry ${kind === 'pr' ? 'active' : ''}`} onClick={() => choose({ kind: 'pr' })}>
            <GitPullRequest size="0.875rem" />
            <span className="label">PR</span>
            <span className="desc">this branch on GitHub</span>
            <kbd>1</kbd>
          </button>
          <div className="entry static">
            <GitBranch size="0.875rem" />
            <span className="label">Branch vs base</span>
            <span className="control">
              <select value={base} onChange={(e) => setBase(e.target.value)} aria-label="Base branch">
                {refOptions.map((r) => (
                  <option key={r} value={r}>
                    {r}
                  </option>
                ))}
              </select>
              <button
                className="primary"
                disabled={!base}
                onClick={() => choose({ kind: 'revspec', args: [`${base}...HEAD`] })}
              >
                Go
              </button>
            </span>
            <kbd>2</kbd>
          </div>
          <button className={`entry ${kind === 'working' ? 'active' : ''}`} onClick={() => choose({ kind: 'working' })}>
            <PencilRuler size="0.875rem" />
            <span className="label">Working</span>
            <span className="desc">HEAD → worktree</span>
            <kbd>3</kbd>
          </button>
          <form
            className="entry static"
            onSubmit={(e) => {
              e.preventDefault();
              choose(lastCommitsRequest(lastCommits));
            }}
          >
            <History size="0.875rem" />
            <span className="label">Last commits</span>
            <span className="control">
              <input
                type="number"
                min={1}
                step={1}
                value={countText}
                onChange={(e) => {
                  setCountText(e.target.value);
                  const n = Number(e.target.value);
                  if (Number.isInteger(n) && n >= 1) setLastCommits(n);
                }}
                onBlur={() => setCountText(String(lastCommits))}
                aria-label="Number of commits"
                className="count"
                title={`HEAD~${lastCommits}..HEAD`}
              />
              <button className="primary" type="submit">
                Go
              </button>
            </span>
            <kbd>4</kbd>
          </form>
          <div className="sep" />
          <button
            className={`entry ${twoRefs ? 'active' : ''}`}
            onClick={() => setTwoRefs((t) => !t)}
            aria-expanded={twoRefs}
          >
            <GitCommitHorizontal size="0.875rem" />
            <span className="label">Two refs…</span>
            <span className="desc">{twoRefs ? <ChevronUp size="0.875rem" /> : <ChevronDown size="0.875rem" />}</span>
            <kbd>5</kbd>
          </button>
          {twoRefs && (
            <form
              className="two-refs"
              onSubmit={(e) => {
                e.preventDefault();
                if (!a || !b) return;
                choose({ kind: 'revspec', args: [`${a}${dots}${b}`] });
              }}
            >
              <RefSelect label="Old" value={a} onChange={setA} refs={refs} />
              <select
                className="dots"
                value={dots}
                onChange={(e) => setDots(e.target.value as '..' | '...')}
                title="… compares from the merge base, .. compares directly"
              >
                <option value="...">... merge-base</option>
                <option value="..">.. direct</option>
              </select>
              <RefSelect label="New" value={b} onChange={setB} refs={refs} allowWorktree />
              <button className="primary" type="submit" disabled={!a || !b}>
                Compare
              </button>
            </form>
          )}
        </div>
      )}
    </div>
  );
}

const OTHER = '\u0000other';

/** Grouped ref dropdown: branches, remotes, tags, recent commits, or free text. */
function RefSelect({
  label,
  value,
  onChange,
  refs,
  allowWorktree,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  refs: RefsResponse | null;
  allowWorktree?: boolean;
}) {
  const known = new Set<string>([
    'HEAD',
    ...(allowWorktree ? ['worktree'] : []),
    ...(refs?.branches ?? []),
    ...(refs?.remoteBranches ?? []),
    ...(refs?.tags ?? []),
    ...(refs?.recent.map((c) => c.short) ?? []),
  ]);
  const [custom, setCustom] = useState(!known.has(value) && value !== '');
  const selectValue = custom ? OTHER : value;
  return (
    <label className="ref-select">
      <span className="lbl">{label}</span>
      <select
        value={selectValue}
        onChange={(e) => {
          if (e.target.value === OTHER) {
            setCustom(true);
            onChange('');
          } else {
            setCustom(false);
            onChange(e.target.value);
          }
        }}
      >
        <option value="" disabled>
          choose…
        </option>
        <optgroup label="Special">
          <option value="HEAD">HEAD</option>
          {allowWorktree && <option value="worktree">worktree (uncommitted)</option>}
        </optgroup>
        {refs && refs.branches.length > 0 && (
          <optgroup label="Branches">
            {refs.branches.map((r) => (
              <option key={r} value={r}>
                {r}
                {r === refs.current ? ' (current)' : ''}
              </option>
            ))}
          </optgroup>
        )}
        {refs && refs.remoteBranches.length > 0 && (
          <optgroup label="Remote branches">
            {refs.remoteBranches.map((r) => (
              <option key={r} value={r}>
                {r}
              </option>
            ))}
          </optgroup>
        )}
        {refs && refs.tags.length > 0 && (
          <optgroup label="Tags">
            {refs.tags.map((r) => (
              <option key={r} value={r}>
                {r}
              </option>
            ))}
          </optgroup>
        )}
        {refs && refs.recent.length > 0 && (
          <optgroup label="Recent commits">
            {refs.recent.map((c) => (
              <option key={c.sha} value={c.short}>
                {c.short} {c.subject.length > 60 ? c.subject.slice(0, 60) + '…' : c.subject}
              </option>
            ))}
          </optgroup>
        )}
        <option value={OTHER}>Other…</option>
      </select>
      {custom && (
        <input
          autoFocus
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder="any revision, e.g. HEAD~3 or a sha"
        />
      )}
    </label>
  );
}
