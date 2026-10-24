'use client';

import { useState } from 'react';
import { Button, Progress, Skeleton } from '@web2bizz/ui/components';
import { EmptyState, ErrorState } from '../../components/states';
import type { OpencodeLimitBucket } from '@rush-code/contracts';
import { useI18n } from '../../i18n';
import { useUsage } from '../../hooks/useUsage';
import { ApiKeyDialog } from './api-key-dialog';

function isUsableBucket(bucket: OpencodeLimitBucket | undefined): bucket is OpencodeLimitBucket {
  return (
    !!bucket &&
    Number.isFinite(bucket.used) &&
    Number.isFinite(bucket.limit) &&
    bucket.limit > 0
  );
}

function toPercent(used: number, limit: number): number {
  const raw = (used / limit) * 100;
  if (!Number.isFinite(raw)) return 0;
  return Math.min(100, Math.max(0, Math.round(raw)));
}

function toneClass(pct: number): string {
  if (pct > 85) return '[&>div]:bg-destructive [&_[data-slot=progress-indicator]]:bg-destructive';
  if (pct >= 60) return '[&>div]:bg-amber-500 [&_[data-slot=progress-indicator]]:bg-amber-500';
  return '[&>div]:bg-emerald-500 [&_[data-slot=progress-indicator]]:bg-emerald-500';
}

export function UsageSection() {
  const { t } = useI18n();
  const { usage, loading, isFetching, status, reload, refetch } = useUsage();
  const [dialogOpen, setDialogOpen] = useState(false);

  const openDialog = () => setDialogOpen(true);

  const skeleton = (
    <div className="grid gap-2" aria-busy="true" aria-label={t.common.loadingPage}>
      <Skeleton className="h-4 w-32" />
      <Skeleton className="h-2 w-full rounded-[var(--radius-sm)]" />
      <Skeleton className="h-4 w-32" />
      <Skeleton className="h-2 w-full rounded-[var(--radius-sm)]" />
      <Skeleton className="h-4 w-32" />
      <Skeleton className="h-2 w-full rounded-[var(--radius-sm)]" />
    </div>
  );

  let body: React.ReactNode = null;

  if (loading) {
    body = skeleton;
  } else if (status.kind === 'missing-key') {
    body = (
      <EmptyState
        title={t.limits.empty}
        description={t.limits.hint}
        actionLabel={t.limits.addKey}
        onAction={openDialog}
      />
    );
  } else if (status.kind === 'invalid-key') {
    body = (
      <EmptyState
        title={t.limits.invalidTitle}
        description={t.limits.invalidDesc}
        actionLabel={t.limits.addKey}
        onAction={openDialog}
      />
    );
  } else if (status.kind === 'session-expired' || status.kind === 'failed') {
    body = (
      <div className="grid gap-1">
        <ErrorState message={status.message} onRetry={reload} />
        {status.kind === 'failed' && status.shortId && (
          <p className="text-muted-foreground text-xs">
            {t.errors.diagnosticId}: {status.shortId}
          </p>
        )}
      </div>
    );
  } else if (!usage) {
    body = (
      <EmptyState
        title={t.limits.empty}
        description={t.limits.hint}
        actionLabel={t.limits.addKey}
        onAction={openDialog}
      />
    );
  } else {
    const rows = [
      { key: 'rolling', label: t.limits.rolling, bucket: usage.rolling },
      { key: 'daily', label: t.limits.daily, bucket: usage.daily },
      { key: 'weekly', label: t.limits.weekly, bucket: usage.weekly },
      { key: 'monthly', label: t.limits.monthly, bucket: usage.monthly },
    ].filter((row): row is { key: string; label: string; bucket: OpencodeLimitBucket } =>
      isUsableBucket(row.bucket),
    );
    if (rows.length === 0) {
      body = <EmptyState title={t.limits.empty} description={t.limits.hint} />;
    } else {
      body = (
        <ul className="grid gap-2">
          {rows.map((row) => {
            const pct = toPercent(row.bucket.used, row.bucket.limit);
            return (
              <li key={row.key} className="grid gap-1 rounded-[var(--radius-sm)] py-2">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-sm">{row.label}</span>
                  <span className="text-muted-foreground text-sm">
                    {row.bucket.used}/{row.bucket.limit}
                  </span>
                </div>
                <Progress value={pct} className={toneClass(pct)} aria-label={row.label} />
              </li>
            );
          })}
        </ul>
      );
    }
  }

  return (
    <section aria-labelledby="profile-limits" className="grid gap-2">
      <h2 id="profile-limits" className="text-lg font-semibold">
        {t.limits.title}
      </h2>
      <p className="text-muted-foreground text-sm">{t.limits.desc}</p>
      {body}
      {!loading && (
        <div className="flex justify-end">
          <Button
            variant="outline"
            size="sm"
            onClick={refetch}
            disabled={isFetching}
            aria-label={t.common.refresh}
            aria-busy={isFetching || undefined}
          >
            {isFetching ? t.common.loading : t.common.refresh}
          </Button>
        </div>
      )}
      <ApiKeyDialog open={dialogOpen} onOpenChange={setDialogOpen} onSaved={reload} />
    </section>
  );
}
