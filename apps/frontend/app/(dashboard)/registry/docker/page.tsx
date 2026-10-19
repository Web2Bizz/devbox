'use client';

import { useState } from 'react';
import {
  Badge,
  Input,
  Label,
  Separator,
} from '@web2bizz/ui/components';
import { EmptyState, ErrorState, LoadingState } from '@/components/states';
import { useRegistries } from '@/hooks/useRegistries';
import { useI18n } from '@/i18n';
import type { RegistryStatus } from '@/lib/types';

function statusColor(status: RegistryStatus) {
  if (status === 'up') return 'success' as const;
  if (status === 'down') return 'destructive' as const;
  return 'muted' as const;
}

/**
 * Route: /registry/docker — linear list of docker registries with live catalog.
 * Moved from /registries (redirect /registries → /registry/docker, see
 * next.config.mjs redirects): deep links keep working.
 * Source: live catalog inside useRegistries (live Docker Registry only;
 * unreachable surfaces as error with retry — no mock data). v1 = one
 * live-catalog source + local list (name/url/status, no secrets); [id] deferred.
 * Flat Content (§6): no Card wrappers — h2 rows + Separator + Badge.
 * Catalog is flat — always rendered as ul/li (mono break-all), no dropdown.
 * No top refresh button, no EmptyState action — retry only via ErrorState.
 */
export default function RegistriesPage() {
  const { t } = useI18n();
  const { registries, loading, error, isEmpty, reload } = useRegistries();
  const [query, setQuery] = useState('');

  const filtered = registries.filter((r) => {
    const q = query.trim().toLowerCase();
    if (!q) return true;
    return (
      r.name.toLowerCase().includes(q) ||
      r.url.toLowerCase().includes(q) ||
      (r.repositories ?? []).some((repo) => repo.toLowerCase().includes(q))
    );
  });

  return (
    <div>
      <div className="mb-4">
        <h1 className="text-2xl font-semibold">
          {t.registries.titleA} <span className="text-gradient-brand">{t.registries.titleB}</span>
        </h1>
        <p className="text-muted-foreground text-sm">{t.registries.subtitle}</p>
      </div>

      <div className="mb-4 grid gap-2" style={{ maxWidth: '24rem' }}>
        <Label htmlFor="registry-search">{t.registries.searchLabel}</Label>
        <Input
          id="registry-search"
          placeholder={t.registries.searchPlaceholder}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
      </div>

      {loading && <LoadingState rows={3} />}
      {error && !loading && <ErrorState message={error} onRetry={reload} />}
      {isEmpty && (
        <EmptyState
          title={t.registries.emptyTitle}
          description={t.registries.emptyDesc}
        />
      )}

      {!loading && !error && !isEmpty && filtered.length === 0 && (
        <EmptyState title={t.registries.noMatchesTitle} description={t.registries.noMatchesDesc(query)} />
      )}

      {!loading && !error && filtered.length > 0 && (
        <ul className="flex flex-col">
          {filtered.map((r, idx) => {
            const repos = r.repositories ?? [];
            return (
              <li key={r.id}>
                {idx > 0 && <Separator />}
                <div className="flex flex-wrap items-center justify-between gap-3 py-3">
                  <div className="min-w-0">
                    <h2 className="text-base font-medium">{r.name}</h2>
                    {r.url && (
                      <p className="text-muted-foreground mono break-all text-sm">{r.url}</p>
                    )}
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    <Badge color={statusColor(r.status)} variant="soft">
                      {r.status}
                    </Badge>
                    <Badge color="info" variant="soft">
                      {repos.length} {t.registries.repositories}
                    </Badge>
                  </div>
                </div>
                <div className="pb-3">
                  {repos.length === 0 ? (
                    <EmptyState
                      title={t.registries.catalogEmpty}
                      description=""
                    />
                  ) : (
                    <ul className="flex flex-col gap-1">
                      {repos.map((repo) => (
                        <li key={repo} className="mono text-muted-foreground break-all text-sm">
                          {repo}
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
