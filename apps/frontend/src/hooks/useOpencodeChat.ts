'use client';

import { useCallback, useEffect, useState } from 'react';
import { opencode, projectScope, toErrorMessage } from '../api/opencode-client';
import { useI18n } from '../i18n';

type MessagesData = NonNullable<
  Awaited<ReturnType<typeof opencode.session.messages>>['data']
>;
export type OpencodeChatMessage = MessagesData[number];

export type UseOpencodeChatResult = {
  messages: OpencodeChatMessage[];
  loading: boolean;
  sending: boolean;
  error: string | null;
  isEmpty: boolean;
  send: (text: string) => Promise<void>;
  reload: () => void;
};

/**
 * Session messages + send through the backend reverse-proxy (same sdk).
 * `send` posts `{ parts: [{ type: 'text', text }] }` to
 * `/api/opencode/session/:id/message` and refreshes the list afterwards.
 * Pass `directory` to scope reads/sends with `?directory=`
 * (backend-ignored) and `projectId` for the C4 `?projectId=` gate
 * (missing → honest 400 PROJECT_REQUIRED as error state) — both ride the
 * shared `projectScope()` helper. No live callers yet (ChatSection uses
 * useChat); the signature stays positional `(sessionId, directory?,
 * projectId?)` so future project tabs pick it up without reshaping.
 */
export function useOpencodeChat(
  sessionId: string | null,
  directory?: string,
  projectId?: string,
): UseOpencodeChatResult {
  const { t } = useI18n();
  const [messages, setMessages] = useState<OpencodeChatMessage[]>([]);
  const [loading, setLoading] = useState(Boolean(sessionId));
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    if (!sessionId) {
      setMessages([]);
      setLoading(false);
      return;
    }
    const ctrl = new AbortController();
    let cancelled = false;
    setLoading(true);
    setError(null);
    opencode.session
      .messages(
        {
          sessionID: sessionId,
          ...(directory ? { directory } : {}),
          ...projectScope(projectId),
        },
        { signal: ctrl.signal },
      )
      .then((res) => {
        if (cancelled) return;
        if (res.error !== undefined || res.data === undefined) {
          const formatted = toErrorMessage(res.error);
          setError(formatted === 'Unexpected error' ? t.errors.unexpected : formatted);
          return;
        }
        setMessages(res.data);
      })
      .catch((e: unknown) => {
        if (cancelled || (e as Error)?.name === 'AbortError') return;
        const formatted = toErrorMessage(e);
        setError(formatted === 'Unexpected error' ? t.errors.unexpected : formatted);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
      ctrl.abort();
    };
  }, [sessionId, directory, projectId, nonce, t]);

  const reload = useCallback(() => setNonce((n) => n + 1), []);

  const send = useCallback(
    async (text: string) => {
      if (!sessionId || !text.trim()) return;
      setSending(true);
      setError(null);
      try {
        const res = await opencode.session.prompt({
          sessionID: sessionId,
          parts: [{ type: 'text', text }],
          ...(directory ? { directory } : {}),
          ...projectScope(projectId),
        });
        if (res.error !== undefined || res.data === undefined) {
          const formatted = toErrorMessage(res.error);
          setError(formatted === 'Unexpected error' ? t.errors.unexpected : formatted);
          return;
        }
        setNonce((n) => n + 1);
      } catch (e: unknown) {
        const formatted = toErrorMessage(e);
        setError(formatted === 'Unexpected error' ? t.errors.unexpected : formatted);
      } finally {
        setSending(false);
      }
    },
    [sessionId, directory, projectId, t],
  );

  return {
    messages,
    loading,
    sending,
    error,
    isEmpty: !loading && !error && messages.length === 0,
    send,
    reload,
  };
}
