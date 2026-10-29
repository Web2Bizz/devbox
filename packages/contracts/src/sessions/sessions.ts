/**
 * Domain session contracts (GET/POST /api/sessions — the product-facing
 * replacement for the deprecated /api/opencode/* mirror).
 *
 * Mirrors contracts/openapi.yaml components/schemas field-for-field:
 * SessionInfo, SessionInfoModel, SessionInfoList, CreateSessionRequest,
 * SessionRunStatus, SessionRunStatusMap.
 *
 * These shapes are OURS: the backend translates the opencode wire forms
 * into them and publishes stable names — `title`/`model` are explicitly
 * nullable (a fresh upstream session carries neither), `directory` is the
 * jailed project path the session lives in (the upstream location field,
 * renamed into our vocabulary), `createdAt` is an ISO-8601 string (our
 * convention, upstream keeps epoch millis). The runtime status is a
 * derived snapshot: busy while the server reports an active drain for the
 * session, idle otherwise; the transient `retry` state exists in the event
 * stream only (see the route docs in openapi.yaml).
 */
import type { OpencodeSessionStatus } from '../opencode-session/opencode-session';

/** Model attached to a session (translated from the upstream model ref). */
export type SessionInfoModel = {
  id: string;
  providerID: string;
  variant?: string;
};

/** One domain session row (GET /api/sessions items, POST /api/sessions result). */
export type SessionInfo = {
  id: string;
  /** null until the server names the session */
  title: string | null;
  /** ISO-8601 creation timestamp */
  createdAt: string;
  /** jailed project directory the session works in */
  directory: string;
  /** owning project (query-bound through the access gate) */
  projectId: string;
  /** null until the session runs on a model */
  model: SessionInfoModel | null;
  status: SessionRunStatus;
};

/** GET /api/sessions — domain session list. */
export type SessionInfoList = SessionInfo[];

/** POST /api/sessions body (projectId is required — sessions are project-scoped). */
export type CreateSessionRequest = {
  projectId: string;
  title?: string;
  /** parent session id when forking under an existing session */
  parentID?: string;
};

/**
 * Runtime status of one session. The union shape is shared with the
 * deprecated mirror contract (single source of truth in the wire types —
 * no duplicated fields); the name is ours.
 */
export type SessionRunStatus = OpencodeSessionStatus;

/** GET /api/sessions/status — sessionId → runtime status map. */
export type SessionRunStatusMap = {
  [sessionId: string]: SessionRunStatus;
};
