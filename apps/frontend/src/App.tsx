import { useEffect, useState } from 'react';
import { api, ApiClientError } from './api/client';
import type { HealthResponse } from '@rush-code/contracts';

export default function App() {
  const [health, setHealth] = useState<HealthResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      try {
        const h = await api.getHealth();
        setHealth(h);
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
    </main>
  );
}
