'use client';

import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@web2bizz/ui/components';
import { ErrorState } from '../components/states';
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

  return (
    <Dialog open={open} onOpenChange={(next) => (busy ? undefined : onOpenChange(next))}>
      <DialogContent showCloseButton={!busy}>
        <DialogHeader>
          <DialogTitle>{t.chat.forkTitle}</DialogTitle>
          <DialogDescription>{t.chat.forkDesc}</DialogDescription>
        </DialogHeader>

        {fork.error ? (
          <ErrorState message={toErrorMessage(fork.error)} retryLabel={t.chat.retry} />
        ) : fork.data ? (
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
