/**
 * OpenCode proxy wire contracts (sdk mirror).
 *
 * Mirrors contracts/openapi.yaml components/schemas field-for-field:
 * OpencodePrompt, OpencodeCommand, OpencodeShell, OpencodeFork,
 * OpencodeSessionUpdate, OpencodeHealth. Upstream session.prompt passthrough —
 * see contracts/opencode-upstream.json; the backend validates these shapes
 * verbatim in apps/backend/src/api/dto.ts (same field constraints +
 * error strings) and the frontend sends them through the SAME
 * @opencode-ai/sdk against `<NEXT_PUBLIC_API_URL>/api/opencode`.
 * Types only — runtime validation lives in opencode.schema.ts.
 */

/** Text part of an OpencodePrompt (the only part most callers send). */
export type OpencodeTextPart = {
  type: 'text';
  text: string;
};

/** File part of an OpencodePrompt (upstream passthrough). */
export type OpencodeFilePart = {
  type: 'file';
  mime: string;
  url: string;
  filename?: string;
};

/** Agent part of an OpencodePrompt (upstream passthrough). */
export type OpencodeAgentPart = {
  type: 'agent';
  name: string;
};

/** Subtask part of an OpencodePrompt (upstream passthrough). */
export type OpencodeSubtaskPart = {
  type: 'subtask';
  prompt: string;
  description: string;
  agent: string;
};

/** Union of accepted prompt parts (upstream `session.prompt` passthrough). */
export type OpencodePart =
  | OpencodeTextPart
  | OpencodeFilePart
  | OpencodeAgentPart
  | OpencodeSubtaskPart;

/** Model reference for prompt/shell bodies (upstream object shape). */
export type OpencodeModelRef = {
  providerID: string;
  modelID: string;
};

/**
 * POST /api/opencode/session/{id}/message body
 * (upstream session.prompt passthrough). Optional messageID/model/agent/
 * noReply/system/tools/variant/format + required non-empty parts.
 */
export type OpencodePrompt = {
  messageID?: string;
  model?: OpencodeModelRef;
  agent?: string;
  noReply?: boolean;
  system?: string;
  tools?: Record<string, boolean>;
  variant?: string;
  /** Upstream OutputFormat passthrough (live only). */
  format?: unknown;
  parts: OpencodePart[];
};

/**
 * POST /api/opencode/session/{id}/command body
 * (upstream session.command passthrough; model is a plain string here,
 * unlike prompt/shell's {providerID, modelID} object).
 */
export type OpencodeCommand = {
  messageID?: string;
  agent?: string;
  model?: string;
  arguments: string;
  command: string;
  variant?: string;
};

/**
 * POST /api/opencode/session/{id}/shell body
 * (upstream session.shell passthrough; agent + command are required).
 */
export type OpencodeShell = {
  messageID?: string;
  agent: string;
  model?: OpencodeModelRef;
  command: string;
};

/** POST /api/opencode/session/{id}/fork body (upstream session.fork passthrough). */
export type OpencodeFork = {
  messageID?: string;
};

/** PATCH /api/opencode/session/{id} body (upstream session.update passthrough). */
export type OpencodeSessionUpdate = {
  title?: string;
};

/** GET /api/opencode/global/health payload (upstream global.health passthrough). */
export type OpencodeHealth = {
  healthy: boolean;
  version: string;
};
