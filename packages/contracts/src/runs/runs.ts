/**
 * Domain run contracts (/api/v1/runs* — the agent-harness run domain).
 *
 * Mirrors contracts/openapi.yaml components/schemas field-for-field:
 * RunStatus, RunInfo, RunInfoList, CreateRunRequest, RunStreamFrame, ToolView.
 *
 * These shapes are OURS: nullable is explicit and never optional — the server
 * always answers the key, null when a run owns no sandbox/agent/model yet.
 * `model` reuses SessionInfoModel and `agentId` the sessions registry id, so
 * the run domain never duplicates a session shape.
 */
import type { SessionInfoModel } from '../sessions/sessions';

export type RunStatus =
  | 'open'
  | 'running'
  | 'awaiting_human'
  | 'failed'
  | 'merged'
  | 'abandoned';

export type RunStepStatus = 'pending' | 'running' | 'committed' | 'failed' | 'skipped';

export type RunStepType =
  | 'llm.call'
  | 'tool.call'
  | 'sandbox.exec'
  | 'git.commit'
  | 'await_human'
  | 'router';

/** One domain run row (GET /api/v1/runs/{id}, POST /api/v1/runs result). */
export type RunInfo = {
  id: string; // uuidv7 (Bun.randomUUIDv7())
  projectId: string; // uuid, C4-scope
  title: string | null; // explicit nullable, never optional
  status: RunStatus;
  definitionSetHash: string; // пин active-набора определений
  baseCommit: string; // sha, Forward-Only нижняя граница
  branch: string; // agent/<run_id>
  worktree: string; // путь внутри REPOS_ROOT jail
  sandboxId: string | null; // opencode-runner слот, nullable
  agentId: string | null; // registry id, nullable как у sessions
  model: SessionInfoModel | null; // reuse из sessions, не дублировать
  createdAt: string; // ISO-8601 Z
  updatedAt: string; // ISO-8601 Z
};

/** GET /api/v1/runs — domain run list. */
export type RunInfoList = Array<RunInfo>;

/** POST /api/v1/runs body (projectId is required — runs are project-scoped). */
export type CreateRunRequest = {
  projectId: string;
  title?: string;
  agentId?: string;
  model?: SessionInfoModel;
  definitionSetHash?: string; // default: active-набор
};

/**
 * Prototype: 4 frame types. TODO(полный RunStreamFrame-union): the full run
 * union carries 6 more types; they stay out of the code until their payloads
 * are pinned by the runner contract.
 */
export type RunStreamFrameTypeProto =
  | 'run.started'
  | 'run.step.started'
  | 'run.step.committed'
  | 'run.step.failed';

/**
 * SSE frame of GET /api/v1/runs/{id}/events — `id` is the per-run monotonic seq
 * rendered as a string (the cursor is the last delivered value); `data` is the
 * variant-owned payload passed through untouched.
 */
export type RunStreamFrame = {
  id: string; // seq как строка, монотонный per-run
  type: RunStreamFrameTypeProto;
  data: Record<string, unknown>;
  run?: string; // hoisted run id
};

// D3: единственное, что видит модель (проекция ToolDescriptor, обрезка на сервере).
export type ToolView = {
  id: string; // '<mcp|skill|native>:<path>' — напр. native:git.recon
  title: string;
  description: string;
  inputSchema: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
};
