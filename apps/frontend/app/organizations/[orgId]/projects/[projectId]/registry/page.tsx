'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useI18n } from '@/i18n';

function SubPage({ title }: { title: string }) {
  const { t } = useI18n();
  const params = useParams();
  const pick = (k: string) => {
    const v = params?.[k];
    return Array.isArray(v) ? v[0] : (v as string | undefined);
  };
  const orgId = pick('orgId');
  const projectId = pick('projectId');
  return (
    <div className="grid gap-2">
      <nav aria-label={t.nav.sections} className="text-muted-foreground flex items-center gap-1 text-sm">
        <Link href={`/organizations/${orgId}/projects/${projectId}`} className="hover:underline">
          {projectId}
        </Link>
        <span aria-hidden="true">/</span>
        <span aria-current="page">{title}</span>
      </nav>
      <h1 className="text-2xl font-semibold">{title}</h1>
      <p className="text-muted-foreground text-sm">
        Scoped to /organizations/{orgId}/projects/{projectId}. Secrets stay masked; merge is backend-only.
      </p>
    </div>
  );
}

export default function NestedRegistryPage() {
  return <SubPage title="Registry" />;
}
