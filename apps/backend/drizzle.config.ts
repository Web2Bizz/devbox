import type { Config } from 'drizzle-kit';

export default {
  // Code-first schema lives under common/db (the old ./src/db path no longer
  // exists — drizzle-kit generate/migrations read this single file).
  schema: './src/common/db/schema.ts',
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
