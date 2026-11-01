import type { Config } from 'drizzle-kit';

export default {
  schema: './src/db/schema.ts',
  out: './drizzle',
  dialect: 'postgresql',
  migrations: {
    table: '__drizzle_migrations_code_first',
    schema: 'drizzle',
  },
  dbCredentials: {
    // drizzle-kit migrate only — never logged; MVP boots without a live DB.
    url: process.env.DATABASE_URL ?? '',
  },
} satisfies Config;
