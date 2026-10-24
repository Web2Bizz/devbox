'use client';

import Link from 'next/link';
import { useCallback, useState } from 'react';
import {
  Alert,
  AlertDescription,
  AlertTitle,
  Button,
  Card,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@web2bizz/ui/components';
import { EmptyState, ErrorState, LoadingState } from '@/components/states';
import { CreateOrganizationDialog } from '@/components/organizations/create-organization-dialog';
import { useOrganizations } from '@/hooks/useOrganizations';
import { useI18n } from '@/i18n';

/**
 * Route: /organizations — membership-scoped list + create.
 * Data from `useOrganizations` (GET /api/v1/organizations via ApiClient);
 * empty/error/loading via hook, create via `CreateOrganizationDialog`.
 * Entity Cards allowed (§6: карточки данных); Alert — только ошибки.
 */
export default function OrganizationsPage() {
  const { t } = useI18n();
  const {
    organizations,
    loading,
    error,
    isEmpty,
    reload,
    createOrganization,
    creating,
    createError,
  } = useOrganizations();
  const [open, setOpen] = useState(false);

  const handleCreate = useCallback(
    async (name: string) => {
      try {
        await createOrganization(name);
      } catch {
        // validation/network error is surfaced via createError from the hook
      }
    },
    [createOrganization],
  );

  return (
    <div>
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold">
            {t.orgs.titleA} <span className="text-gradient-brand">{t.orgs.titleB}</span>
          </h1>
          <p className="text-muted-foreground text-sm">{t.orgs.subtitle}</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button variant="outline" size="sm" onClick={reload} disabled={loading}>
            {loading ? t.common.loading : t.common.refresh}
          </Button>
          <CreateOrganizationDialog
            open={open}
            onOpenChange={setOpen}
            onCreate={handleCreate}
            creating={creating}
            trigger={
              <Button variant="primaryBrand" size="sm">
                {t.orgs.createTrigger}
              </Button>
            }
          />
        </div>
      </div>

      {createError && (
        <Alert variant="destructive" className="mb-4">
          <AlertTitle>{t.errors.somethingWentWrong}</AlertTitle>
          <AlertDescription>{createError}</AlertDescription>
        </Alert>
      )}

      {loading && <LoadingState rows={3} />}
      {error && !loading && <ErrorState message={error} />}
      {isEmpty && <EmptyState title={t.orgs.emptyTitle} description={t.orgs.emptyDesc} />}

      {!loading && !error && !isEmpty && (
        <div className="status-grid">
          {organizations.map((o) => (
            <Link
              key={o.id}
              href={`/organizations/${o.id}`}
              aria-label={o.name}
              className="block h-full rounded-[var(--radius-lg)] focus-visible:outline-2 focus-visible:outline-offset-2"
            >
              <Card variant="default" className="h-full">
                <CardHeader>
                  <CardTitle>{o.name}</CardTitle>
                  {o.description && <CardDescription>{o.description}</CardDescription>}
                </CardHeader>
              </Card>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
