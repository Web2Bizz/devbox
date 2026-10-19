'use client';

import { useEffect, useState } from 'react';
import {
  Alert,
  AlertDescription,
  AlertTitle,
  Button,
  Field,
  FieldLabel,
  Input,
  Separator,
} from '@web2bizz/ui/components';
import { ErrorState, ProjectDetailSkeleton } from '@/components/states';
import { UsageSection } from '@/features/usage/usage-section';
import { useProfile } from '@/hooks/useProfile';
import { useI18n } from '@/i18n';

/**
 * Route: /profile — flat Content (§7: no nested Cards, h2 + Separator).
 * Real API: GET/PATCH /api/v1/auth/me via useProfile. Email is read-only
 * (backend PATCH accepts only firstName/lastName) — displayed as text
 * plus a disabled input with a hint, never sent.
 * Limits live in the usage feature module (`src/features/usage/`:
 * `useUsage` + `UsageSection` + `ApiKeyDialog`) — this page only composes
 * `<UsageSection />` and owns no usage business logic.
 */
export default function ProfilePage() {
  const { t } = useI18n();
  const { profile, loading, error, saved, saving, update, reload } = useProfile();
  const [name, setName] = useState('');

  useEffect(() => {
    if (profile) {
      setName(profile.name);
    }
  }, [profile]);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    await update({ name });
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

          <UsageSection />
        </div>
      )}
    </div>
  );
}
