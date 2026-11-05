/**
 * Domain session contracts (GET/POST /api/v1/sessions — the product-facing
 * replacement for the deprecated /api/opencode/* mirror).
 *
 * Mirrors contracts/openapi.yaml components/schemas field-for-field:
 * SessionInfo, SessionInfoModel, SessionInfoList, CreateSessionRequest,
 * SessionRunStatus, SessionRunStatusMap, SessionMessage,
 * SendMessageRequest, SessionStreamFrame, InterruptSessionRequest,
 * SessionInterruptResult, SessionRunnerProvider.
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

/** Model available to the runner, listed by GET /api/v1/sessions/models. */
export type SessionModel = {
  id: string;
  name: string;
  providerID: string;
};

/**
 * AI agent available to chat, listed by GET /api/v1/agents (backend
 * AgentsService registry; today the single Ask agent answering through the
 * harness-owned runner). Mirrors contracts/openapi.yaml AgentInfo
 * field-for-field (same id/name/description shape as the backend AgentDto).
 */
export type AgentInfo = {
  id: string;
  name: string;
  description: string;
};

/** GET /api/v1/agents — agent registry list. */
export type AgentInfoList = Array<AgentInfo>;

/** One domain session row (GET /api/v1/sessions items, POST /api/v1/sessions result). */
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
  /**
   * Agent answering this session (registry id, e.g. 'ask'). Nullable, never
   * optional: the server always answers the key, null when the session was
   * created without an agent (pre-agent rows / runner-default turns).
   */
  agentId: string | null;
  status: SessionRunStatus;
};

/** GET /api/v1/sessions — domain session list. */
export type SessionInfoList = Array<SessionInfo>;

/** POST /api/v1/sessions body (projectId is required — sessions are project-scoped). */
export type CreateSessionRequest = {
  projectId: string;
  title?: string;
  /** parent session id when forking under an existing session */
  parentID?: string;
  /**
   * Model to run the session on (upstream `Model.Ref` shape, reused as
   * SessionInfoModel — never a duplicate). Optional: without it the runner
   * picks its server default (nothing invented client-side).
   */
  model?: SessionInfoModel;
  /**
   * Agent answering the session (registry id, e.g. 'ask'). Optional and
   * additive (existing clients sending no agentId keep working): without it
   * the session answers through the default 'ask' agent.
   */
  agentId?: string;
};

/**
 * Runtime status of one session. The union shape is shared with the
 * deprecated mirror contract (single source of truth in the wire types —
 * no duplicated fields); the name is ours.
 */
export type SessionRunStatus = OpencodeSessionStatus;

/** GET /api/v1/sessions/status — sessionId → runtime status map. */
export type SessionRunStatusMap = {
  [sessionId: string]: SessionRunStatus;
};

/**
 * Domain session message (GET/POST /api/v1/sessions/{id}/messages) — the
 * NORMALIZED projection of the upstream `Session.Message.Info` union
 * (provenance: contracts/opencode-stand-2.2.0.json Session.Message.*
 * variants). Every field maps to an upstream source:
 * - `id`   ← the union's required message id,
 * - `type` ← the variant discriminator (user | assistant | system |
 *   synthetic | shell | skill | idle | agent-switched | model-switched |
 *   location-switched | compaction …; kept as a string — the variant set
 *   is upstream-owned and grows),
 * - `createdAt` ← the required `time.created` (epoch millis → ISO-8601),
 * - `text` ← the plain-text rendering the chat UI consumes: `text` for
 *   user/system/synthetic variants, `content[]` `text`-items joined for
 *   assistant, null for every other variant (shell/skill/idle/… carry no
 *   chat bubble; their non-consumed nesting is intentionally dropped).
 */
export type SessionMessage = {
  id: string;
  /** upstream variant discriminator — see the list in the type docs */
  type: string;
  /** ISO-8601 */
  createdAt: string;
  /** plain-text projection; null for non-text variants (never faked) */
  text: string | null;
};

/** GET /api/v1/sessions/{id}/messages — normalized message list. */
export type SessionMessageList = Array<SessionMessage>;

/**
 * POST /api/v1/sessions/{id}/messages body — the domain chat prompt. `text`
 * mirrors the v2 prompt's only required payload field (files/agents/skills/
 * metadata/delivery are upstream-optional and no UI consumes them yet —
 * deliberately not exposed until there is a consumer). `model` is the same
 * SessionInfoModel ref as on create (never a duplicate); without it the
 * runner keeps the session model (nothing invented client-side).
 */
export type SendMessageRequest = {
  projectId: string;
  text: string;
  model?: SessionInfoModel;
  /**
   * Agent answering this turn (registry id, e.g. 'ask'). Optional and
   * additive: without it the session keeps its stored agent (default 'ask').
   */
  agentId?: string;
};

/**
 * SSE frame emitted by GET /api/v1/sessions/events (domain translation of the
 * v2 event stream, provenance: artifact eventFrames — {id, type, data}
 * flat frame). The backend re-keys the upstream `data.sessionID` to the
 * top-level `session` so consumers never touch the upstream name; `data`
 * itself is the variant-owned payload passed through untouched (the union
 * is large and upstream-owned — envelope-only here, matching
 * OpencodeEvent's stance).
 */
export type SessionStreamFrame = {
  id: string;
  type: string;
  data: Record<string, unknown>;
  /** hoisted from upstream data.sessionID when the variant carries one */
  session?: string;
};

/** message.part.delta frame — the streaming text unit the chat renders. */
export type SessionMessagePartDeltaFrame = SessionStreamFrame & {
  type: "message.part.delta";
  data: {
    sessionID: string;
    messageID: string;
    partID: string;
    field: string;
    delta: string;
  };
};

/** message.part.updated frame — absolute text snapshot of a part. */
export type SessionMessagePartUpdatedFrame = SessionStreamFrame & {
  type: "message.part.updated";
  data: {
    sessionID: string;
    part: Record<string, unknown>;
  };
};

/**
 * POST /api/v1/sessions/{id}/interrupt body — projectId is the gate uuid.
 * The runner's own resume knob (artifact interrupt parameters `resume`)
 * has no UI consumer and is deliberately not exposed — nothing invented.
 */
export type InterruptSessionRequest = {
  projectId: string;
};

/**
 * POST /api/v1/sessions/{id}/interrupt answer — domain form of the artifact's
 * SessionInterruptResponse ({interrupted} verbatim, the only field the
 * live 2.2.0 spec carries). `interrupted: false` is the idle no-op (the
 * session was not running) — an honest answer, never an error.
 * Provenance: contracts/opencode-stand-2.2.0.json
 * paths['/api/session/{sessionID}/interrupt'] → SessionInterruptResponse.
 */
export type SessionInterruptResult = {
  interrupted: boolean;
};

/**
 * GET /api/v1/sessions/providers row — the project's runner provider
 * inventory. Fields are exactly the REQUIRED set of the artifact's
 * Provider.Info (id/name/activation/package); optional and sensitive
 * Provider.Info members (settings/headers/body — headers can carry auth
 * material) are never shipped to the browser and not consumed by the UI.
 * Provenance: contracts/opencode-stand-2.2.0.json paths['/api/provider']
 * → components.schemas['Provider.Info'] (required subset).
 */
export type SessionRunnerProvider = {
  id: string;
  name: string;
  /** artifact Provider.Info.activation enum */
  activation: 'auto' | 'enabled' | 'disabled';
  package: string;
};

/** GET /api/v1/sessions/providers — provider inventory list. */
export type SessionRunnerProviderList = Array<SessionRunnerProvider>;
