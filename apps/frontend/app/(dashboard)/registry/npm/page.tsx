'use client';

import { useState } from 'react';
import {
  Badge,
  Input,
  Label,
  Separator,
} from '@web2bizz/ui/components';
import { EmptyState, ErrorState, LoadingState } from '@/components/states';
import { useNpm } from '@/hooks/useNpm';
import { useI18n } from '@/i18n';
import type { NpmStatus } from '@/lib/types';

function statusColor(status: NpmStatus) {
  if (status === 'up') return 'success' as const;
  if (status === 'down') return 'destructive' as const;
  return 'muted' as const;
}

/**
 * Route: /registry/npm — flat npm registry status (live reachability only).
 * Moved from /npm (redirect /npm → /registry/npm, see next.config.mjs
 * redirects): deep links keep working.
 * Source: live status inside useNpm (unreachable surfaces as error
 * with retry — no mock data, token never in payload).
 * Flat Content (§6): no Card wrappers — h2 rows + Separator + Badge.
 * No top refresh button, no EmptyState action — retry only via ErrorState.
 */
export default function NpmPage() {
  const { t } = useI18n();
  const { packages, loading, error, isEmpty, reload } = useNpm();
  const [query, setQuery] = useState('');

  const filtered = packages.filter((p) => {
    const q = query.trim().toLowerCase();
    if (!q) return true;
    return (
      p.name.toLowerCase().includes(q) ||
      p.url.toLowerCase().includes(q) ||
      p.scope.toLowerCase().includes(q)
    );
  });

  return (
    <div>
      <div className="mb-4">
        <h1 className="text-2xl font-semibold">
          {t.npm.titleA} <span className="text-gradient-brand">{t.npm.titleB}</span>
        </h1>
        <p className="text-muted-foreground text-sm">{t.npm.subtitle}</p>
      </div>

      <div className="mb-4 grid gap-2" style={{ maxWidth: '24rem' }}>
        <Label htmlFor="npm-search">{t.npm.searchLabel}</Label>
        <Input
          id="npm-search"
          placeholder={t.npm.searchPlaceholder}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
      </div>

      {loading && <LoadingState rows={3} />}
      {error && !loading && <ErrorState message={error} onRetry={reload} />}
      {isEmpty && (
        <EmptyState
          title={t.npm.emptyTitle}
          description={t.npm.emptyDesc}
        />
      )}

      {!loading && !error && !isEmpty && filtered.length === 0 && (
        <EmptyState title={t.npm.noMatchesTitle} description={t.npm.noMatchesDesc(query)} />
      )}

      {!loading && !error && filtered.length > 0 && (
        <ul className="flex flex-col">
          {filtered.map((p, idx) => (
            <li key={p.id}>
              {idx > 0 && <Separator />}
              <div className="flex flex-wrap items-center justify-between gap-3 py-3">
                <div className="min-w-0">
                  <h2 className="text-base font-medium">{p.name}</h2>
                  {p.url && (
                    <p className="text-muted-foreground mono break-all text-sm">{p.url}</p>
                  )}
                  {p.scope && (
                    <p className="text-muted-foreground text-sm">
                      {t.npm.scopeLabel}: {p.scope}
                    </p>
                  )}
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <Badge color={statusColor(p.status)} variant="soft">
                    {p.status}
                  </Badge>
                </div>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
