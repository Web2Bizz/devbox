/**
 * @rush-code/contracts — shared Rush Code wire contracts.
 *
 * Entity types + zod v4 boundary schemas, single source of truth for
 * backend/frontend (replaces the backend/frontend contracts.ts + lib
 * *-schemas.ts duplications). Every module mirrors
 * contracts/openapi.yaml components/schemas field-for-field and reuses
 * the backend dto constraints verbatim (min/max/email/uuid + messages);
 * the ApiError envelope stays frozen (new code VALUES only, never fields).
 * Types only + schemas — no runtime logic, no console output.
 */

export * from './health/health';
export * from './health/health.schema';
export * from './session/session';
export * from './session/session.schema';
export * from './repo-entry/repo-entry';
export * from './repo-entry/repo-entry.schema';
export * from './api-error/api-error';
export * from './api-error/api-error.schema';
export * from './auth/auth';
export * from './auth/auth.schema';
export * from './project/project';
export * from './project/project.schema';
export * from './organization/organization';
export * from './organization/organization.schema';
export * from './opencode-key/opencode-key';
export * from './opencode-key/opencode-key.schema';
