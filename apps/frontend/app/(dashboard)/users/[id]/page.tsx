'use client';

import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { Badge } from '@web2bizz/ui/components';
import {
  EmptyState,
  ErrorState,
  ProjectDetailSkeleton,
} from '@/components/states';
import { useUser } from '@/hooks/useUser';
import { useI18n } from '@/i18n';

/**
 * Route: /users/[id] — private single profile (GET /api/v1/users/:id).
 * Own id → profile rows; чужой id → backend 403 → ErrorState «доступ запрещён».
 * No list fetching — single id only. Own full editing stays on /profile.
 */
export default function UserDetailPage() {
  const { t } = useI18n();
  const params = useParams();
  const router = useRouter();
  const raw = params?.id;
  const id = Array.isArray(raw) ? raw[0] : (raw as string | undefined);
  const { user, loading, error, notFound, forbidden, reload } = useUser(id);

  return (
    <div>
      <div className="mb-4">
        <h1 className="text-2xl font-semibold">
          {t.users.titleA} <span className="text-gradient-brand">{t.users.titleB}</span>
        </h1>
        <p className="text-muted-foreground text-sm">{t.users.subtitle}</p>
      </div>

      {loading && <ProjectDetailSkeleton />}

      {!loading && notFound && (
        <EmptyState
          title={t.users.notFoundTitle}
          description={error ?? t.users.notFoundDesc}
          actionLabel={t.users.back}
          onAction={() => router.push('/profile')}
        />
      )}

      {!loading && !notFound && forbidden && <ErrorState message={error ?? t.users.forbiddenDesc} onRetry={reload} />}

      {!loading && !notFound && !forbidden && error && <ErrorState message={error} onRetry={reload} />}

      {!loading && !error && !notFound && !forbidden && user && (
        <div className="grid gap-2">
          <h2 className="text-lg font-semibold">
            {user.firstName} {user.lastName}
          </h2>
          <p className="text-muted-foreground text-sm">{user.email}</p>
          <p>
            <Badge color="info" variant="soft">
              {user.provider}
            </Badge>
          </p>
          <div>
            <Link
              href="/profile"
              className="text-sm underline-offset-4 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2"
            >
              {t.users.back} →
            </Link>
          </div>
        </div>
      )}
    </div>
  );
}
