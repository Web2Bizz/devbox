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

export * from './health';
export * from './session';
export * from './repo-entry';
export * from './api-error';
export * from './auth';
export * from './project';
export * from './organization';
export * from './opencode-key';
export * from './opencode';
export * from './opencode-session';
export * from './opencode-event';
export * from './sessions';
