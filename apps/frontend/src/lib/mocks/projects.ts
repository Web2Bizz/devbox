import type { Project } from '../types';

/**
 * Legacy mock fixtures — retained only for unit tests / storybook.
 * Production hooks (`useProjects` / `useProject`) no longer import this;
 * they talk directly to `GET /api/v1/projects` via ApiClient.
 */
export const MOCK_PROJECTS: Project[] = [
  {
    id: 'prj-web',
    name: 'Marketing site',
    description: 'Next.js landing + docs, deployed via Dokploy.',
    status: 'active',
    updatedAt: '2026-09-20T10:00:00.000Z',
    repo: 'web2bizz/marketing',
    corrupted: false,
    corruptedReason: null,
  },
  {
    id: 'prj-api',
    name: 'Billing API',
    description: 'Draft service, still wiring Stripe webhooks.',
    status: 'draft',
    updatedAt: '2026-09-24T14:30:00.000Z',
    repo: 'web2bizz/billing-api',
    corrupted: false,
    corruptedReason: null,
  },
  {
    id: 'prj-legacy',
    name: 'Legacy cron runner',
    description: 'Archived after migration to schedules.',
    status: 'archived',
    updatedAt: '2026-08-02T09:00:00.000Z',
    corrupted: false,
    corruptedReason: null,
  },
];
