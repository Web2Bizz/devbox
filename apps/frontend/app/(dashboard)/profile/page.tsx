'use client';

import { useEffect, useState } from 'react';
import {
  Alert,
  AlertDescription,
  AlertTitle,
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Field,
  FieldDescription,
  FieldError,
  FieldLabel,
  Input,
  Progress,
  Separator,
  Skeleton,
} from '@web2bizz/ui/components';
import { EmptyState, ErrorState, ProjectDetailSkeleton } from '../../../src/components/states';
import { useProfile } from '../../../src/hooks/useProfile';
import { useUsage } from '../../../src/hooks/useUsage';
import { ApiClientError, api } from '../../../src/api/client';
import { formatApiError } from '../../../src/lib/format-error';
import { getValidAccessToken, refreshAccessToken } from '../../../src/lib/auth-store';
import { useI18n } from '../../../src/i18n';
import type { OpencodeLimitBucket } from '../../../src/api/types';

/**
 * Real bucket guard — finite used/limit with a positive limit.
 * Non-finite or missing buckets are not renderable (no fake 0% bars).
 */
function isUsableBucket(bucket: OpencodeLimitBucket | undefined): bucket is OpencodeLimitBucket {
  return (
    !!bucket &&
    Number.isFinite(bucket.used) &&
    Number.isFinite(bucket.limit) &&
    bucket.limit > 0
  );
}

/** Percent from a REAL used/limit pair only (never from the usage total). */
function toPercent(used: number, limit: number): number {
  const raw = (used / limit) * 100;
  if (!Number.isFinite(raw)) return 0;
  return Math.min(100, Math.max(0, Math.round(raw)));
}

/**
 * Indicator tone via kit Progress className only (no hex, no gradients,
 * no shadows/transforms in this block; radii stay var(--radius*)).
 * Kit Indicator is hardcoded bg-primary — the child selector recolors it
 * through the kit className API (direct child + data-slot fallback).
 */
function toneClass(pct: number): string {
  if (pct > 85) return '[&>div]:bg-destructive [&_[data-slot=progress-indicator]]:bg-destructive';
  if (pct >= 60) return '[&>div]:bg-amber-500 [&_[data-slot=progress-indicator]]:bg-amber-500';
  return '[&>div]:bg-emerald-500 [&_[data-slot=progress-indicator]]:bg-emerald-500';
}

/**
 * Route: /profile — flat Content (§7: no nested Cards, h2 + Separator).
 * Real API: GET/PATCH /api/v1/auth/me via useProfile. Email is read-only
 * (backend PATCH accepts only firstName/lastName) — displayed as text
 * plus a disabled input with a hint, never sent.
 * Limits: live GET /api/v1/usage via useUsage — percentages ONLY from real
 * used/limit pairs (rolling 5h / daily legacy / weekly / monthly, additive
 * backend breakdown; Zen Go percent is exposed as { used: percent, limit: 100 }).
 * No breakdown → Empty (never 0% fake bars, never derived from the total).
 */
export default function ProfilePage() {
  const { t } = useI18n();
  const { profile, loading, error, saved, saving, update, reload } = useProfile();
  const {
    usage,
    loading: usageLoading,
    error: usageError,
    noKeyMissing,
    noKeyInvalid,
    upstreamDown,
    reload: reloadUsage,
  } = useUsage();
  const [name, setName] = useState('');
  const [keyDialogOpen, setKeyDialogOpen] = useState(false);
  const [apiKey, setApiKey] = useState('');
  const [savingKey, setSavingKey] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  useEffect(() => {
    if (profile) {
      setName(profile.name);
    }
  }, [profile]);

  useEffect(() => {
    if (!keyDialogOpen) {
      setSaveError(null);
      setSavingKey(false);
    }
  }, [keyDialogOpen]);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    await update({ name });
  };

  const openKeyDialog = () => {
    setApiKey('');
    setSaveError(null);
    setKeyDialogOpen(true);
  };

  /**
   * Save the OpenCode API key via PUT /api/v1/key, then reload usage
   * (which re-resolves both the key status and the limits: 404 no-key /
   * 401 rejected key inline, 5xx section ErrorState, 200 live). The raw key
   * is never logged.
   */
  const saveKey = async (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = apiKey.trim();
    if (!trimmed) {
      setSaveError(t.limits.required);
      return;
    }
    if (trimmed.length < 20) {
      setSaveError(t.limits.tooShort);
      return;
    }
    setSavingKey(true);
    setSaveError(null);
    try {
      let token = await getValidAccessToken();
      if (!token) {
        setSaveError(t.errors.sessionExpired);
        return;
      }
      try {
        await api.putKey(token, { apiKey: trimmed });
      } catch (err) {
        if (err instanceof ApiClientError && err.status === 401) {
          token = await refreshAccessToken();
          if (!token) {
            setSaveError(t.errors.sessionExpired);
            return;
          }
          await api.putKey(token, { apiKey: trimmed });
        } else {
          throw err;
        }
      }
      setApiKey('');
      setKeyDialogOpen(false);
      reloadUsage();
    } catch (err) {
      const formatted = formatApiError(err);
      setSaveError(formatted === 'Unexpected error' ? t.errors.unexpected : formatted);
    } finally {
      setSavingKey(false);
    }
  };

  return (
    <div>
      <div className="mb-4">
        <h1 className="text-2xl font-semibold">
          {t.profile.titleA} {t.profile.titleB}
        </h1>
        <p className="text-muted-foreground text-sm">{t.profile.subtitle}</p>
      </div>

      {loading && <ProjectDetailSkeleton />}
      {error && !loading && !profile && <ErrorState message={error} onRetry={reload} />}

      {profile && (
        <div className="grid gap-6">
          <section aria-labelledby="profile-overview" className="grid gap-2">
            <h2 id="profile-overview" className="text-lg font-semibold">
              {t.profile.overviewTitle}
            </h2>
            <p className="text-muted-foreground text-sm">{t.profile.overviewDesc}</p>
            <ul className="grid gap-2">
              <li className="flex flex-wrap items-center gap-2 rounded-[var(--radius-sm)] py-2">
                <span className="text-muted-foreground text-sm">{t.profile.nameLabel}</span>
                <span className="text-sm">{profile.name}</span>
              </li>
              <li className="grid gap-1 rounded-[var(--radius-sm)] py-2">
                <span className="text-muted-foreground text-sm">{t.profile.emailLabel}</span>
                <span className="text-sm">{profile.email}</span>
                <span className="text-muted-foreground text-xs">{t.profile.emailReadOnlyHint}</span>
              </li>
              <li className="text-muted-foreground text-xs">
                {t.profile.sincePrefix} {new Date(profile.createdAt).toLocaleDateString()}
              </li>
            </ul>
          </section>

          <Separator />

          <section aria-labelledby="profile-edit" className="grid gap-2">
            <h2 id="profile-edit" className="text-lg font-semibold">
              {t.profile.editTitle}
            </h2>
            <p className="text-muted-foreground text-sm">{t.profile.editDesc}</p>
            {error && (
              <Alert variant="destructive">
                <AlertTitle>{t.errors.updateFailed}</AlertTitle>
                <AlertDescription>{error}</AlertDescription>
              </Alert>
            )}
            {saved && !error && (
              <Alert>
                <AlertTitle>{t.profile.savedTitle}</AlertTitle>
                <AlertDescription>{t.profile.savedDesc}</AlertDescription>
              </Alert>
            )}
            <form onSubmit={submit} className="grid gap-4" style={{ maxWidth: '32rem' }}>
              <Field>
                <FieldLabel htmlFor="profile-name">{t.profile.nameLabel}</FieldLabel>
                <Input
                  id="profile-name"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder={t.profile.namePlaceholder}
                />
              </Field>
              <Field>
                <FieldLabel htmlFor="profile-email">{t.profile.emailLabel}</FieldLabel>
                <Input
                  id="profile-email"
                  type="email"
                  value={profile.email}
                  disabled
                  readOnly
                  aria-describedby="profile-email-hint"
                />
                <p id="profile-email-hint" className="text-muted-foreground text-xs">
                  {t.profile.emailReadOnlyHint}
                </p>
              </Field>
              <div className="flex gap-2">
                <Button type="submit" variant="primaryBrand" disabled={saving}>
                  {saving ? t.profile.saving : t.profile.saveChanges}
                </Button>
                <Button type="button" variant="outline" onClick={reload} disabled={saving || loading}>
                  {t.profile.reset}
                </Button>
              </div>
            </form>
          </section>

          <Separator />

          <section aria-labelledby="profile-limits" className="grid gap-2">
            <h2 id="profile-limits" className="text-lg font-semibold">
              {t.limits.title}
            </h2>
            <p className="text-muted-foreground text-sm">{t.limits.desc}</p>
            {usageLoading && (
              <div className="grid gap-2" aria-busy="true" aria-label={t.common.loadingPage}>
                <Skeleton className="h-4 w-32" />
                <Skeleton className="h-2 w-full rounded-[var(--radius-sm)]" />
                <Skeleton className="h-4 w-32" />
                <Skeleton className="h-2 w-full rounded-[var(--radius-sm)]" />
                <Skeleton className="h-4 w-32" />
                <Skeleton className="h-2 w-full rounded-[var(--radius-sm)]" />
              </div>
            )}
            {!usageLoading && upstreamDown && (
              <ErrorState message={usageError ?? t.errors.unexpected} onRetry={reloadUsage} />
            )}
            {!usageLoading && !upstreamDown && usageError && (
              <ErrorState message={usageError} onRetry={reloadUsage} />
            )}
            {!usageLoading && !upstreamDown && !usageError && noKeyMissing && (
              <EmptyState
                title={t.limits.empty}
                description={t.limits.hint}
                actionLabel={t.limits.addKey}
                onAction={openKeyDialog}
              />
            )}
            {!usageLoading && !upstreamDown && !usageError && !noKeyMissing && noKeyInvalid && (
              <EmptyState
                title={t.limits.invalidTitle}
                description={t.limits.invalidDesc}
                actionLabel={t.limits.addKey}
                onAction={openKeyDialog}
              />
            )}
            {!usageLoading &&
              !upstreamDown &&
              !usageError &&
              !noKeyMissing &&
              !noKeyInvalid &&
              !usage && (
                <EmptyState
                  title={t.limits.empty}
                  description={t.limits.hint}
                  actionLabel={t.limits.addKey}
                  onAction={openKeyDialog}
                />
              )}
            {!usageLoading && !upstreamDown && !usageError && !noKeyMissing && !noKeyInvalid && usage && (() => {
              const rows = [
                { key: 'rolling', label: t.limits.rolling, bucket: usage.rolling },
                { key: 'daily', label: t.limits.daily, bucket: usage.daily },
                { key: 'weekly', label: t.limits.weekly, bucket: usage.weekly },
                { key: 'monthly', label: t.limits.monthly, bucket: usage.monthly },
              ].filter((row): row is { key: string; label: string; bucket: OpencodeLimitBucket } =>
                isUsableBucket(row.bucket),
              );
              if (rows.length === 0) {
                return <EmptyState title={t.limits.empty} description={t.limits.hint} />;
              }
              return (
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
            })()}
          </section>

          <Dialog
            open={keyDialogOpen}
            onOpenChange={(open) => {
              if (!savingKey) setKeyDialogOpen(open);
            }}
          >
            <DialogContent showCloseButton={!savingKey}>
              <DialogHeader>
                <DialogTitle>{t.limits.dialogTitle}</DialogTitle>
                <DialogDescription>{t.limits.dialogDesc}</DialogDescription>
              </DialogHeader>

              <form id="limits-key-form" onSubmit={saveKey} className="grid gap-4">
                <Field>
                  <FieldLabel htmlFor="limits-api-key">{t.limits.keyLabel}</FieldLabel>
                  <Input
                    id="limits-api-key"
                    type="password"
                    autoComplete="new-password"
                    autoFocus
                    placeholder={t.limits.keyPlaceholder}
                    aria-describedby={saveError ? 'limits-key-error' : 'limits-key-hint'}
                    aria-invalid={!!saveError}
                    disabled={savingKey}
                    value={apiKey}
                    onChange={(e) => setApiKey(e.target.value)}
                  />
                  <FieldDescription id="limits-key-hint">{t.limits.keyHint}</FieldDescription>
                  {saveError && <FieldError id="limits-key-error">{saveError}</FieldError>}
                </Field>
              </form>

              <DialogFooter>
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => setKeyDialogOpen(false)}
                  disabled={savingKey}
                >
                  {t.common.cancel}
                </Button>
                <Button
                  type="submit"
                  form="limits-key-form"
                  variant="primaryBrand"
                  disabled={savingKey || apiKey.trim().length === 0}
                >
                  {savingKey ? t.limits.saving : t.limits.save}
                </Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>
        </div>
      )}
    </div>
  );
}
