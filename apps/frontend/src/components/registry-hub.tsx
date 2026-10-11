'use client';

import Link from 'next/link';
import {
  Card,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@web2bizz/ui/components';

export interface RegistryHubItem {
  href: string;
  title: string;
  description: string;
}

/**
 * Reusable hub grid: Card per entry with a direct Next Link.
 * Used by /registry (Docker + npm); reuse the same `items[]` shape for
 * future storages/databases hubs (S3 + Volumes, Postgres + Redis, …).
 * Hub pages are the DESIGN §6 exception that may use Card wrappers —
 * leaf list pages (/registry/docker, /registry/npm) stay flat.
 */
export function RegistryHub({ items }: { items: readonly RegistryHubItem[] }) {
  return (
    <div className="status-grid">
      {items.map((item) => (
        <Card key={item.href}>
          <CardHeader>
            <CardTitle>
              <Link href={item.href}>{item.title}</Link>
            </CardTitle>
            <CardDescription>{item.description}</CardDescription>
          </CardHeader>
        </Card>
      ))}
    </div>
  );
}
