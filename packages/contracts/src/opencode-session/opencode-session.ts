/**
 * OpenCode mirror session + status contracts (sdk mirror read side).
 *
 * Mirrors contracts/openapi.yaml components/schemas field-for-field:
 * OpencodeLocationRef, OpencodeSessionModelRef, OpencodeSessionTokens,
 * OpencodeSessionTime, OpencodePermissionRule/Effect,
 * OpencodeSessionFork/ForkBoundary, OpencodeFileDiff, OpencodeSessionRevert,
 * OpencodeSession, OpencodeSessionStatus(+Action), OpencodeSessionStatusMap.
 *
 * Shapes are upstream passthroughs of the opencode 2.x server — fields are
 * owned by the upstream spec, NOT by Rush Code (the /api/opencode/* mirror
 * relays them verbatim and unwraps the {data}/{data,cursor} envelopes; it
 * never re-maps or renames). Provenance per field group:
 * - live stand openapi.json 2.2.0 components/schemas `Session.Info`,
 *   `Location.PublicRef`, `TokenUsage.Info`, `Money.USD`, `Model.Ref`,
 *   `Permission.Ruleset/Rule/Effect`, `Session.ForkBoundary`,
 *   `Session.Revert`, `FileDiff.Info`, `Session.Metadata`;
 * - live SSE/JSON probes of GET /api/session(…), GET /api/session/{id};
 * - pinned @opencode-ai/sdk v2 `SessionV2Info`/`SessionStatus` where the
 *   2.2.0 spec carries no equivalent (status — see its note).
 * The thin legacy `Session` in session/session.ts stays the
 * GET /api/v1/session contract and is deliberately NOT touched here —
 * this family is named `Opencode*` (same convention as OpencodeHealth /
 * OpencodeSessionUpdate) so one wire shape never has two names.
 * Types only — runtime validation lives in opencode-session.schema.ts.
 *
 * Provenance artifact: contracts/opencode-stand-2.2.0.json (live stand
 * openapi.json filtered to the used paths/schemas — the authoritative
 * shapes for every disputed field):
 * - FileDiff.Info is {file, patch, additions, deletions, status, more?}:
 *   the pinned sdk 1.18.33 FileDiff still names the field `path` —
 *   upstream itself renamed path -> file by 2.2.0, the artifact is proof;
 * - Session.Info.required = [id, projectID, cost, tokens, time, location]
 *   — `title` is NOT required (absent on a fresh session, probe-verified);
 * - Session.Info.time carries optional idle/viewed (epoch millis);
 * - Session.Revert carries NO `diff` in 2.2.0 (sdk RevertState.diff was
 *   dropped upstream);
 * - Location.PublicRef = {directory} only — sdk LocationRef.workspaceID?
 *   is not part of the published 2.2.0 location shape.
 */

/** Session location — jailed directory of the project (upstream Location.PublicRef). */
export type OpencodeLocationRef = {
  /** absolute directory path the session is jailed to */
  directory: string;
};

/** Model reference attached to a session (upstream Model.Ref; NOT the prompt-body OpencodeModelRef). */
export type OpencodeSessionModelRef = {
  id: string;
  providerID: string;
  variant?: string;
};

/** Token usage counters of a session (upstream TokenUsage.Info). */
export type OpencodeSessionTokenCache = {
  read: number;
  write: number;
};

export type OpencodeSessionTokens = {
  input: number;
  output: number;
  reasoning: number;
  cache: OpencodeSessionTokenCache;
};

/** Session timestamps — epoch millis (upstream Session.Info.time). */
export type OpencodeSessionTime = {
  created: number;
  updated: number;
  /** present on the live spec only; may be absent until the server sets them */
  idle?: number;
  viewed?: number;
  archived?: number;
};

/** Terminal outcome of a session run (upstream Session.Info.outcome enum). */
export type OpencodeSessionOutcome = 'succeeded' | 'failed' | 'interrupted';

/** Permission rule effect (upstream Permission.Effect). */
export type OpencodePermissionEffect = 'allow' | 'deny' | 'ask';

/** One permission rule of the session ruleset (upstream Permission.Rule). */
export type OpencodePermissionRule = {
  action: string;
  resource: string;
  effect: OpencodePermissionEffect;
};

/** Fork cut position (upstream Session.ForkBoundary — before | through a message). */
export type OpencodeSessionForkBoundary = {
  type: 'before' | 'through';
  messageID: string;
};

/** Provenance of a forked session (upstream Session.Info.fork). */
export type OpencodeSessionFork = {
  sessionID: string;
  boundary: OpencodeSessionForkBoundary;
};

/** File change row of a revert snapshot (upstream FileDiff.Info). */
export type OpencodeFileDiff = {
  file: string;
  patch: string;
  additions: number;
  deletions: number;
  status: 'added' | 'deleted' | 'modified';
  /** upstream narrows this to the literal `true` (pagination marker) */
  more?: true;
};

/** Revert state attached to a session (upstream Session.Revert). */
export type OpencodeSessionRevert = {
  messageID: string;
  partID?: string;
  snapshot?: string;
  files?: OpencodeFileDiff[];
};

/** Free-form session metadata (upstream Session.Metadata — `{type: object}`). */
export type OpencodeSessionMetadata = {
  [key: string]: unknown;
};

/**
 * Opencode session as the /api/opencode/* mirror answers — GET /api/opencode/session
 * (array item), POST /api/opencode/session and GET /api/opencode/session/{id}
 * (verbatim upstream `Session.Info` passthrough, envelope unwrapped).
 * required set = the live spec required list; everything else appears only
 * once the server sets it (a freshly created session carries no `title`).
 */
export type OpencodeSession = {
  id: string;
  /** optional upstream: parent of a forked/sub session */
  parentID?: string;
  projectID: string;
  /** active agent id once set */
  agent?: string;
  model?: OpencodeSessionModelRef;
  /** upstream Money.USD — plain number */
  cost: number;
  tokens: OpencodeSessionTokens;
  /** terminal outcome once known */
  outcome?: OpencodeSessionOutcome;
  time: OpencodeSessionTime;
  /** optional upstream: absent on a fresh session (verified by live probe) */
  title?: string;
  /** relative subpath inside the jail once known */
  subpath?: string;
  metadata?: OpencodeSessionMetadata;
  permissions?: OpencodePermissionRule[];
  fork?: OpencodeSessionFork;
  revert?: OpencodeSessionRevert;
  location: OpencodeLocationRef;
};

/** GET /api/opencode/session — the mirror unwraps the upstream {data,cursor} envelope to a bare array (cursor dropped). */
export type OpencodeSessionList = OpencodeSession[];

/** Retry action detail carried by a `retry` status (upstream session.status payload). */
export type OpencodeSessionStatusAction = {
  reason: string;
  provider: string;
  title: string;
  message: string;
  label: string;
  link?: string;
};

/**
 * Live status of a single session (upstream `session.status` payload).
 *
 * Shape source: the pinned @opencode-ai/sdk v2 `SessionStatus` union — the
 * 2.2.0 openapi.json publishes no session-status schema, and the legacy
 * GET /session/status path the mirror's status route proxies is not served
 * by the current stand (SPA catch-all): see the open question in the task
 * report (serving it = card 4 domain routes). Consumers must treat unknown
 * `type` values as 'unknown', never as busy/idle.
 */
export type OpencodeSessionStatus =
  | { type: 'idle' }
  | { type: 'busy' }
  | {
      type: 'retry';
      attempt: number;
      message: string;
      /** epoch millis of the next retry attempt */
      next: number;
      action?: OpencodeSessionStatusAction;
    };

/** GET /api/opencode/session/status — sessionID → status map (upstream passthrough). */
export type OpencodeSessionStatusMap = {
  [sessionID: string]: OpencodeSessionStatus;
};
