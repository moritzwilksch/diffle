import { Pencil } from 'lucide-react';
import { useRef, useState } from 'react';
import { api } from '@/client/api.js';
import { Button } from '@/client/ui/Button.js';
import { Dialog, DialogContent } from '@/client/ui/dialog.js';
import { TextArea } from '@/client/ui/TextArea.js';

export function GithubPendingEdit({ prUrl, id, body }: { prUrl: string; id: string; body: string }) {
  const [draft, setDraft] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const saving = useRef(false);
  const ready = !!draft?.trim() && draft.trim() !== body.trim();

  async function save() {
    if (!draft || !ready || saving.current) return;
    saving.current = true;
    setBusy(true);
    setError(undefined);
    try {
      await api.editGithubPendingComment(id, prUrl, draft);
      setDraft(undefined);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      saving.current = false;
      setBusy(false);
    }
  }

  return (
    <>
      <Button
        variant="ghost"
        icon
        title="Edit pending comment"
        aria-label="Edit pending comment"
        onClick={() => {
          setError(undefined);
          setDraft(body);
        }}
      >
        <Pencil size="0.75rem" />
      </Button>
      {draft != null && (
        <Dialog open onOpenChange={(open) => !open && !saving.current && setDraft(undefined)}>
          <DialogContent aria-label="Edit pending GitHub comment">
            <h2 className="mb-2 font-semibold">Edit pending GitHub comment</h2>
            <form
              onSubmit={(event) => {
                event.preventDefault();
                void save();
              }}
            >
              <TextArea
                aria-label="Comment"
                autoFocus
                className="min-h-28 w-full resize-y rounded-sm border border-border bg-surface px-2 py-1.5"
                value={draft}
                onValueChange={setDraft}
                disabled={busy}
                onKeyDown={(event) => {
                  if (event.key !== 'Enter' || !(event.ctrlKey || event.metaKey) || event.nativeEvent.isComposing)
                    return;
                  event.preventDefault();
                  void save();
                }}
              />
              {error && (
                <p role="alert" className="mt-2 text-sm text-warn">
                  {error}
                </p>
              )}
              <div className="mt-3 flex justify-end gap-2">
                <Button type="button" disabled={busy} onClick={() => setDraft(undefined)}>
                  Cancel
                </Button>
                <Button type="submit" variant="primary" disabled={busy || !ready}>
                  {busy ? 'Saving…' : 'Save comment'}
                </Button>
              </div>
            </form>
          </DialogContent>
        </Dialog>
      )}
    </>
  );
}
