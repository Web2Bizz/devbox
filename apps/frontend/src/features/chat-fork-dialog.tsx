'use client';

import { useEffect, useRef } from 'react';
import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@web2bizz/ui/components';
import { toast } from '@web2bizz/ui/widgets';
import { toErrorMessage } from '../api/sessions-client';
import { useI18n } from '../i18n';
import { useForkSession } from '../hooks/useForkSession';

export type ChatForkDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  sessionId: string | null;
  projectId?: string;
  /** Boundary message the dialog was opened from. */
  messageId: string | null;
};

/**
 * Fork dialog (kit `Dialog`): choose the boundary — strictly before the
 * message the dialog was opened from, or the whole thread (through the
 * newest message). `POST /fork` copies the durable thread server-side; the
 * hook invalidates the list/thread caches, and the new session id is shown
 * honestly (the shell has no router-driven session switch here).
 */
export function ChatForkDialog({
  open,
  onOpenChange,
  sessionId,
  projectId,
  messageId,
}: ChatForkDialogProps) {
  const { t } = useI18n();
  const fork = useForkSession(sessionId, projectId);
  const busy = fork.isPending;

  // Toast-only errors (kit sonner): fork failures surface as a top-right
  // toast with Retry (invalidateQueries via `fork.mutate`); the dialog stays
  // open so the boundary choice is never lost.
  const lastErrorRef = useRef<string | null>(null);
  const forkError = fork.error ? toErrorMessage(fork.error) : null;
  useEffect(() => {
    if (!forkError) {
      lastErrorRef.current = null;
      return;
    }
    if (lastErrorRef.current === forkError) return;
    lastErrorRef.current = forkError;
    toast.error(t.errors.somethingWentWrong, {
      id: `fork:${forkError}`,
      description: forkError,
      duration: 5500,
      action: {
        label: t.common.retry,
        onClick: () => fork.mutate(messageId ?? undefined),
      },
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [forkError, t]);

  return (
    <Dialog open={open} onOpenChange={(next) => (busy ? undefined : onOpenChange(next))}>
      <DialogContent showCloseButton={!busy}>
        <DialogHeader>
          <DialogTitle>{t.chat.forkTitle}</DialogTitle>
          <DialogDescription>{t.chat.forkDesc}</DialogDescription>
        </DialogHeader>

        {fork.data ? (
          <p className="text-sm text-muted-foreground">
            {t.chat.forkSuccess}: <span className="font-mono text-xs">{fork.data.session.id}</span>
          </p>
        ) : null}

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
              if (messageId) fork.mutate(messageId);
            }}
            disabled={busy || !messageId}
          >
            {t.chat.forkBefore}
          </Button>
          <Button
            type="button"
            variant="default"
            onClick={() => fork.mutate(undefined)}
            disabled={busy}
          >
            {t.chat.forkWhole}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
