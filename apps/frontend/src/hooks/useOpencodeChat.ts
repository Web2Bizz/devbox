'use client';

import { useCallback, useEffect, useState } from 'react';
import { opencode, toErrorMessage } from '../api/opencode-client';
import { useI18n } from '../i18n';

type MessagesData = NonNullable<
  Awaited<ReturnType<typeof opencode.session.messages>>['data']
>;
export type OpencodeChatMessage = MessagesData[number];

export interface UseOpencodeChatResult {
  messages: OpencodeChatMessage[];
  loading: boolean;
  sending: boolean;
  error: string | null;
  isEmpty: boolean;
  send: (text: string) => Promise<void>;
  reload: () => void;
}

/**
 * Session messages + send through the backend reverse-proxy (same sdk).
 * `send` posts `{ parts: [{ type: 'text', text }] }` to
 * `/api/opencode/session/:id/message` and refreshes the list afterwards.
 * Pass `directory` to scope both reads and sends with `?directory=`
 * (same projectId → directory contract as useOpencodeSessions).
 */
export function useOpencodeChat(
  sessionId: string | null,
  directory?: string,
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
        directory
          ? { path: { id: sessionId }, query: { directory }, signal: ctrl.signal }
          : { path: { id: sessionId }, signal: ctrl.signal },
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
  }, [sessionId, directory, nonce, t]);

  const reload = useCallback(() => setNonce((n) => n + 1), []);

  const send = useCallback(
    async (text: string) => {
      if (!sessionId || !text.trim()) return;
      setSending(true);
      setError(null);
      try {
        const res = await opencode.session.prompt({
          path: { id: sessionId },
          body: { parts: [{ type: 'text', text }] },
          ...(directory ? { query: { directory } } : {}),
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
    [sessionId, directory, t],
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
