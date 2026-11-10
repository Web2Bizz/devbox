import { z } from 'zod';

/** RFC 9562 UUID (any version, case-insensitive) — user/project/run ids. */
export const uuidSchema: z.ZodUUID = z.uuid();

/** UUID v7 only — invite tokens (`Bun.randomUUIDv7()`). */
export const uuidV7Schema: z.ZodUUID = z.uuidv7();
