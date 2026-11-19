import { Trash2 } from 'lucide-react';
import { useRef, useState } from 'react';
import { api } from '@/client/api.js';
import { useStore } from '@/client/store.js';
import { Button } from '@/client/ui/Button.js';
import { Dialog, DialogContent } from '@/client/ui/dialog.js';
import type { GithubCommentMessage } from '@/shared/protocol.js';
import { closeGithubPeek } from './commentPeek.js';

export function GithubPendingDelete({ prUrl, message }: { prUrl: string; message: GithubCommentMessage }) {
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const running = useRef(false);
  if (!message.canDelete) return null;

  async function remove() {
    if (running.current) return;
    running.current = true;
    setBusy(true);
    setError(undefined);
    try {
      await api.deleteGithubPendingComment(message.id, prUrl);
      setConfirm(false);
      closeGithubPeek(message.id);
      useStore.getState().flash('Deleted pending GitHub comment');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      running.current = false;
      setBusy(false);
    }
  }

  return (
    <>
      <Button
        variant="ghost"
        danger
        icon
        title="Delete pending comment"
        aria-label="Delete pending comment"
        onClick={() => {
          setError(undefined);
          setConfirm(true);
        }}
      >
        <Trash2 size="0.75rem" />
      </Button>
      {confirm && (
        <Dialog
          open
          onOpenChange={(open) => {
            if (!open && !running.current) setConfirm(false);
          }}
        >
          <DialogContent role="alertdialog" aria-label="Delete pending GitHub comment">
            <h2 className="font-semibold">Delete pending GitHub comment?</h2>
            <p className="mt-2 text-sm text-muted">
              Are you sure you want to delete this comment from your pending review?
            </p>
            {error && (
              <p role="alert" className="mt-2 text-sm text-warn">
                {error}
              </p>
            )}
            <div className="mt-4 flex justify-end gap-2">
              <Button autoFocus disabled={busy} onClick={() => setConfirm(false)}>
                Cancel
              </Button>
              <Button danger feedback="confirm" disabled={busy} onClick={() => void remove()}>
                {busy ? 'Deleting…' : 'Delete comment'}
              </Button>
            </div>
          </DialogContent>
        </Dialog>
      )}
    </>
  );
}
