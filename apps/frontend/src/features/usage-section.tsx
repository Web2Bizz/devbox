'use client';

import { useEffect, useRef, useState } from 'react';
import { Button, Progress, Skeleton } from '@web2bizz/ui/components';
import { toast } from '@web2bizz/ui/widgets';
import { EmptyState } from '../components/states';
import type { OpencodeLimitBucket } from '@rush-code/contracts';
import { useI18n } from '../i18n';
import { useUsage } from '../hooks/useUsage';
import { ApiKeyDialog } from './usage-api-key-dialog';

function isUsableBucket(bucket: OpencodeLimitBucket | undefined): bucket is OpencodeLimitBucket {
  return (
    !!bucket &&
    Number.isFinite(bucket.used) &&
    Number.isFinite(bucket.limit) &&
    bucket.limit > 0
  );
}

function toPercent(used: number, limit: number): number {
  const raw: number = (used / limit) * 100;
  if (!Number.isFinite(raw)) return 0;
  return Math.min(100, Math.max(0, Math.round(raw)));
}

function toneClass(pct: number): string {
  if (pct > 85) return '[&>div]:bg-destructive [&_[data-slot=progress-indicator]]:bg-destructive';
  if (pct >= 60)
    return '[&>div]:bg-accent-secondary [&_[data-slot=progress-indicator]]:bg-accent-secondary';
  return '[&>div]:bg-primary [&_[data-slot=progress-indicator]]:bg-primary';
}

export function UsageSection() {
  const { t } = useI18n();
  const { usage, loading, isFetching, status, reload, refetch } = useUsage();
  const [dialogOpen, setDialogOpen] = useState<boolean>(false);

  const openDialog = () => setDialogOpen(true);

  // Toast-only errors (kit sonner): usage failures surface as a top-right
  // toast with Retry (invalidateQueries via `reload`); the section keeps
  // its last body so the layout never jumps.
  const lastErrorRef = useRef<string | null>(null);
  useEffect(() => {
    if (status.kind !== 'session-expired' && status.kind !== 'failed') {
      lastErrorRef.current = null;
      return;
    }
    if (lastErrorRef.current === status.message) return;
    lastErrorRef.current = status.message;
    toast.error(t.errors.somethingWentWrong, {
      id: `usage:${status.message}`,
      description:
        status.kind === 'failed' && status.shortId
          ? `${status.message} — ${t.errors.diagnosticId}: ${status.shortId}`
          : status.message,
      duration: 5500,
      action: { label: t.common.retry, onClick: reload },
    });
  }, [status, reload, t]);

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
  } else {
    // Branches share only the `status.kind` discriminant (not the logic):
    // missing/invalid-key render distinct EmptyStates, session-expired/failed
    // share the error body — so they are grouped cases, not a merged branch.
    switch (status.kind) {
      case 'missing-key':
        body = (
          <EmptyState
            title={t.limits.empty}
            description={t.limits.hint}
            actionLabel={t.limits.addKey}
            onAction={openDialog}
          />
        );
        break;
      case 'invalid-key':
        body = (
          <EmptyState
            title={t.limits.invalidTitle}
            description={t.limits.invalidDesc}
            actionLabel={t.limits.addKey}
            onAction={openDialog}
          />
        );
        break;
      case 'session-expired':
      case 'failed':
        body = (
          <div className="grid gap-1">
            <p className="text-muted-foreground text-sm">{status.message}</p>
            {status.kind === 'failed' && status.shortId && (
              <p className="text-muted-foreground text-xs">
                {t.errors.diagnosticId}: {status.shortId}
              </p>
            )}
          </div>
        );
        break;
      default:
        if (!usage) {
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
        break;
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
