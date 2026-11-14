'use client';

import { useEffect, useRef } from 'react';
import {
  Badge,
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Separator,
} from '@web2bizz/ui/components';
import { toast } from '@web2bizz/ui/widgets';
import { toErrorMessage } from '../api/sessions-client';
import { useI18n } from '../i18n';
import { useRevert } from '../hooks/useRevert';

export type ChatRevertDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  sessionId: string | null;
  projectId?: string;
  /** Boundary message the revert is staged from. */
  messageId: string | null;
};

/**
 * Revert dialog (kit `Dialog`): opening it stages the boundary message
 * (`POST /revert/stage`) and shows the per-file diff the turn produced.
 * Commit keeps the restored tree, Discard clears the staged state (files
 * return to their pre-stage tree) — both are the domain endpoints, the
 * backend remains the truth (the hook invalidates the thread cache).
 *
 * Flat content only: `h2 + p.text-muted-foreground`, `ol/li` diff rows,
 * `Separator` + `Badge`, kit buttons. No Card/border/background/shadow.
 */
export function ChatRevertDialog({
  open,
  onOpenChange,
  sessionId,
  projectId,
  messageId,
}: ChatRevertDialogProps) {
  const { t } = useI18n();
  const { stage, clear, commit } = useRevert(sessionId, projectId);
  const busy = stage.isPending || clear.isPending || commit.isPending;

  useEffect(() => {
    if (open && messageId) stage.mutate(messageId);
    // Restaging per opened message only; the mutation object is stable per hook.
  }, [open, messageId]);

  const files = stage.data?.files ?? [];
  const error = stage.error ?? clear.error ?? commit.error;

  // Toast-only errors (kit sonner): revert failures surface as a top-right
  // toast with Retry (stage redial); the dialog stays open so the staged
  // boundary choice is never lost.
  const lastErrorRef = useRef<string | null>(null);
  const errorText = error ? toErrorMessage(error) : null;
  useEffect(() => {
    if (!errorText) {
      lastErrorRef.current = null;
      return;
    }
    if (lastErrorRef.current === errorText) return;
    lastErrorRef.current = errorText;
    toast.error(t.errors.somethingWentWrong, {
      id: `revert:${errorText}`,
      description: errorText,
      duration: 5500,
      ...(messageId
        ? {
            action: {
              label: t.chat.retry,
              onClick: () => stage.mutate(messageId),
            },
          }
        : {}),
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [errorText, t]);

  return (
    <Dialog open={open} onOpenChange={(next) => (busy ? undefined : onOpenChange(next))}>
      <DialogContent showCloseButton={!busy}>
        <DialogHeader>
          <DialogTitle>{t.chat.revertTitle}</DialogTitle>
          <DialogDescription>{t.chat.revertDesc}</DialogDescription>
        </DialogHeader>

        {stage.isPending ? (
          <p className="text-sm text-muted-foreground" aria-busy="true">
            {t.chat.revertStage}
          </p>
        ) : files.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t.chat.revertEmpty}</p>
        ) : (
          <>
            <p className="text-xs text-muted-foreground">
              <Badge variant="secondary">{files.length}</Badge>
            </p>
            <Separator />
            <ol className="grid max-h-80 gap-2 overflow-y-auto">
              {files.map((file) => (
                <li key={file.file} className="grid gap-1 text-sm">
                  <span className="break-words font-mono text-xs">{file.file}</span>
                  {file.hunks ? (
                    <pre className="overflow-x-auto rounded-[var(--radius-md)] bg-muted p-2 text-xs text-muted-foreground">
                      {file.hunks}
                    </pre>
                  ) : null}
                </li>
              ))}
            </ol>
          </>
        )}

        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={busy}
          >
            {t.chat.dialogClose}
          </Button>
          <Button
            type="button"
            variant="outline"
            onClick={() => {
              clear.mutate();
              onOpenChange(false);
            }}
            disabled={busy || !stage.data}
          >
            {t.chat.revertDiscard}
          </Button>
          <Button
            type="button"
            variant="default"
            onClick={() => {
              commit.mutate();
              onOpenChange(false);
            }}
            disabled={busy || !stage.data || files.length === 0}
          >
            {t.chat.revertCommit}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
