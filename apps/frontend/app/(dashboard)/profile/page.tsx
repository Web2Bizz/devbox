'use client';

import { useEffect, useState } from 'react';
import {
  Alert,
  AlertDescription,
  AlertTitle,
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
  Field,
  FieldLabel,
  Input,
} from '@web2bizz/ui/components';
import { ErrorState, LoadingState } from '../../../src/components/states';
import { useProfile } from '../../../src/hooks/useProfile';
import { useI18n } from '../../../src/i18n';

/**
 * Route: /profile — Card + form with success/error Alerts.
 * TODO REAL-API: no page changes — swap inside useProfile only.
 */
export default function ProfilePage() {
  const { t } = useI18n();
  const { profile, loading, error, saved, saving, update, reload } = useProfile();
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');

  useEffect(() => {
    if (profile) {
      setName(profile.name);
      setEmail(profile.email);
    }
  }, [profile]);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    await update({ name, email });
  };

  return (
    <div>
      <div className="mb-4">
        <h1 className="text-2xl font-semibold">
          {t.profile.titleA} <span className="text-gradient-brand">{t.profile.titleB}</span>
        </h1>
        <p className="text-muted-foreground text-sm">{t.profile.subtitle}</p>
      </div>

      {loading && <LoadingState rows={1} />}
      {error && !loading && !profile && <ErrorState message={error} onRetry={reload} />}

      {profile && (
        <Card variant="brand" style={{ maxWidth: '32rem' }}>
          <CardHeader>
            <CardTitle>{profile.name}</CardTitle>
            <CardDescription>
              <Badge color="info" variant="soft">
                {profile.role}
              </Badge>{' '}
              <span className="text-muted-foreground text-xs">
                {t.profile.sincePrefix} {new Date(profile.createdAt).toLocaleDateString()}
              </span>
            </CardDescription>
          </CardHeader>
          <form onSubmit={submit}>
            <CardContent className="grid gap-4">
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
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="dev@devbox.local"
                />
              </Field>
            </CardContent>
            <CardFooter className="flex gap-2">
              <Button type="submit" variant="primaryBrand" disabled={saving}>
                {saving ? t.profile.saving : t.profile.saveChanges}
              </Button>
              <Button type="button" variant="outline" onClick={reload} disabled={saving || loading}>
                {t.profile.reset}
              </Button>
            </CardFooter>
          </form>
        </Card>
      )}
    </div>
  );
}
