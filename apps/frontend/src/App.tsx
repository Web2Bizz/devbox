import { useEffect, useState } from 'react';
import { api, ApiClientError } from './api/client';
import type { HealthResponse, SendChatResponse, Session } from '@rush-code/contracts';

export default function App() {
  const [health, setHealth] = useState<HealthResponse | null>(null);
  const [session, setSession] = useState<Session | null>(null);
  const [chat, setChat] = useState<SendChatResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      try {
        const h = await api.getHealth();
        setHealth(h);
        const s = await api.getSession();
        setSession(s);
        const reply = await api.sendChat('hello from frontend', s.id);
        setChat(reply);
      } catch (e) {
        setError(e instanceof ApiClientError ? `${e.code}: ${e.message}` : (e as Error).message);
      }
    })();
  }, []);

  return (
    <main style={{ fontFamily: 'system-ui', padding: 32 }}>
      <h1>Rush Code MVP</h1>
      <p>
        API: <code>{api.baseUrl}</code>
      </p>
      {error && <p style={{ color: 'crimson' }}>Backend unreachable: {error}</p>}
      {health ? (
        <p>
          Backend status: <strong>{health.status}</strong> (db: {health.db})
        </p>
      ) : (
        !error && <p>Checking backend…</p>
      )}
      {session && (
        <p>
          Session: <code>{session.id}</code> — {session.title}
          {session.model ? ` (${session.model})` : ''}
        </p>
      )}
      {chat && (
        <blockquote style={{ borderLeft: '3px solid var(--border)', paddingLeft: 12 }}>
          {chat.message.content}
        </blockquote>
      )}
    </main>
  );
}
