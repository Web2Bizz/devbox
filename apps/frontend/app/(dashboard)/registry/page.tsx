'use client';

import { RegistryHub } from '../../../src/components/registry-hub';
import { useI18n } from '../../../src/i18n';

/**
 * Route: /registry — hub with two Card links (Docker → /registry/docker,
 * npm → /registry/npm). DESIGN §6 exception: hub pages may use Card
 * wrappers; leaf pages (/registry/docker, /registry/npm) stay flat
 * (h2 rows + Separator + Badge). Reusable RegistryHub `items[]` fits
 * future storages/databases hubs.
 */
export default function RegistryPage() {
  const { t } = useI18n();

  return (
    <div>
      <div className="mb-4">
        <h1 className="text-2xl font-semibold">
          {t.registry.titleA} <span className="text-gradient-brand">{t.registry.titleB}</span>
        </h1>
        <p className="text-muted-foreground text-sm">{t.registry.subtitle}</p>
      </div>

      <RegistryHub
        items={[
          {
            href: '/registry/docker',
            title: t.registry.dockerTitle,
            description: t.registry.dockerDesc,
          },
          {
            href: '/registry/npm',
            title: t.registry.npmTitle,
            description: t.registry.npmDesc,
          },
        ]}
      />
    </div>
  );
}
