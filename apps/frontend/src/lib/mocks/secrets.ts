import type { SecretItem } from '../types';

/**
 * MOCK secret fixtures — previews only, never real values.
 * TODO REAL-API: replace with GET /api/v1/secrets (masked) +
 * POST /api/v1/secrets/:id/reveal inside `useSecrets`.
 * All exports keep the MOCK_ prefix by convention.
 */
export const MOCK_SECRETS: SecretItem[] = [
  {
    id: 'sec-stripe',
    name: 'STRIPE_SECRET_KEY',
    projectId: 'prj-api',
    maskedPreview: 'sk-••••4242',
    updatedAt: '2026-09-22T12:00:00.000Z',
  },
  {
    id: 'sec-openai',
    name: 'OPENAI_API_KEY',
    projectId: 'prj-web',
    maskedPreview: 'sk-••••9182',
    updatedAt: '2026-09-18T08:30:00.000Z',
  },
  {
    id: 'sec-db',
    name: 'DATABASE_URL',
    projectId: 'prj-api',
    maskedPreview: 'postgres://••••@db:5432',
    updatedAt: '2026-09-10T16:45:00.000Z',
  },
];

/** Fake revealed values for the mock — clearly not production secrets. */
export const MOCK_SECRET_VALUES: Record<string, string> = {
  'sec-stripe': 'MOCK_sk_test_4242_do_not_use',
  'sec-openai': 'MOCK_sk_openai_9182_do_not_use',
  'sec-db': 'MOCK_postgres://user:pass@db:5432/app',
};
