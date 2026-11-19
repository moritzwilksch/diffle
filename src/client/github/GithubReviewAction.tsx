import { ClipboardCheck } from 'lucide-react';
import { useRef, useState } from 'react';
import type { GithubReviewDecision, PullRef } from '@/shared/protocol.js';
import { api } from '@/client/api.js';
import { useStore } from '@/client/store.js';
import { Button } from '@/client/ui/Button.js';
import { Dialog, DialogContent } from '@/client/ui/dialog.js';
import { TextArea } from '@/client/ui/TextArea.js';

const decisions = [
  ['comment', 'Comment'],
  ['approve', 'Approve'],
  ['request-changes', 'Request changes'],
] as const;

export function GithubReviewAction() {
  const pr = useStore((s) => (s.snapshot?.review.kind === 'range' ? s.snapshot.review.pr : undefined));
  const version = useStore((s) => s.snapshot?.version);
  if (!pr || version == null) return null;
  return <ReviewTrigger key={pr.url} pr={pr} version={version} />;
}

function ReviewTrigger({ pr, version }: { pr: PullRef; version: number }) {
  const [draftVersion, setDraftVersion] = useState<number>();
  return (
    <>
      <Button
        aria-label="Review changes"
        title="Submit your GitHub review"
        variant="ghost"
        onClick={() => setDraftVersion(version)}
      >
        <ClipboardCheck size="1rem" /> <span className="max-lg:hidden">Review changes</span>
      </Button>
      {draftVersion != null && (
        <ReviewDialog
          pr={pr}
          currentVersion={version}
          version={draftVersion}
          onClose={() => setDraftVersion(undefined)}
        />
      )}
    </>
  );
}

function ReviewDialog({
  pr,
  currentVersion,
  version,
  onClose,
}: {
  pr: PullRef;
  currentVersion: number;
  version: number;
  onClose: () => void;
}) {
  const [summary, setSummary] = useState('');
  const [decision, setDecision] = useState<GithubReviewDecision>('comment');
  const [saving, setSaving] = useState(false);
  const submitting = useRef(false);
  const [error, setError] = useState<string>();
  const github = useStore((s) => s.github);
  const metadata = github.data?.version === version ? github.data : undefined;
  const blocked =
    currentVersion !== version
      ? 'The comparison changed. Reopen this dialog to review the current changes.'
      : metadata
        ? metadata.reason
        : github.status === 'error'
          ? github.error
          : 'Checking review availability…';
  const requiresSummary = decision === 'request-changes';
  const enabled = !saving && !blocked && (!requiresSummary || Boolean(summary.trim()));

  const submit = async () => {
    if (!enabled || submitting.current) return;
    submitting.current = true;
    setSaving(true);
    setError(undefined);
    try {
      await api.submitGithubReview({ version, decision, summary });
      useStore.getState().flash(`Submitted review for #${pr.number}`);
      onClose();
    } catch (error) {
      setError(error instanceof Error ? error.message : String(error));
    } finally {
      submitting.current = false;
      setSaving(false);
    }
  };

  return (
    <Dialog open onOpenChange={(open) => !open && !submitting.current && onClose()}>
      <DialogContent aria-label={`Review pull request #${pr.number}`}>
        <h2 className="font-semibold">Review pull request #{pr.number}</h2>
        <p className="mt-1 mb-4 text-sm text-muted">Your pending GitHub comments will be included.</p>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
        >
          <label className="block text-sm">
            General comment
            <TextArea
              value={summary}
              onValueChange={setSummary}
              placeholder="Summarize your review…"
              className="mt-1 block min-h-24 w-full resize-y rounded-sm border border-border bg-surface px-2 py-1.5"
              required={requiresSummary}
              disabled={saving}
            />
          </label>
          <fieldset className="mt-3 flex flex-wrap gap-4 text-sm" disabled={saving}>
            <legend className="mb-1 font-medium">Decision</legend>
            {decisions.map(([value, label]) => (
              <label className="inline-flex items-center gap-1.5" key={value}>
                <input
                  type="radio"
                  name="review-decision"
                  checked={decision === value}
                  onChange={() => setDecision(value)}
                />
                {label}
              </label>
            ))}
          </fieldset>
          {blocked && <p className="mt-3 text-sm text-muted">{blocked}</p>}
          {error && (
            <p className="mt-3 text-sm text-warn" role="alert">
              {error}
            </p>
          )}
          <div className="mt-4 flex justify-end gap-2">
            <Button type="button" onClick={onClose} disabled={saving}>
              Cancel
            </Button>
            <Button type="submit" variant="primary" disabled={!enabled}>
              {saving ? 'Submitting…' : 'Submit review'}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
