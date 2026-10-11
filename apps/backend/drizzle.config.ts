import type { Config } from 'drizzle-kit';

export default {
  schema: './src/db/schema.ts',
  out: './drizzle',
  dialect: 'postgresql',
  dbCredentials: {
    // drizzle-kit migrate only — never logged; MVP boots without a live DB.
    url: process.env.DATABASE_URL ?? '',
  },
} satisfies Config;
