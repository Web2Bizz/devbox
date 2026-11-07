import { Injectable } from '@nestjs/common';
import type { Request as ExpressRequest, Response as ExpressResponse } from 'express';
import type {
  CreateSessionInput,
  InterruptSessionInput,
  RevertInfo,
  RevertStageRequest,
  SendMessageInput,
  SessionForkRequest,
  SessionForkResponse,
  SessionInfo,
  SessionInterruptResult,
  SessionMessage,
  SessionRunStatusMap,
  SessionRunnerProvider,
  SnapshotDiff,
} from './sessions.dto';
import { SessionHarnessService } from './session-harness.service';

/**
 * SessionsService — thin domain facade behind /api/v1/sessions*.
 *
 * Card 1 (harness-core): all orchestration (create/send/interrupt/status,
 * transport + opencode → Rush Code translation) lives in
 * SessionHarnessService behind the SessionHarness interface; this service
 * keeps the stable domain method names the controller calls so the
 * sessions/* contract and the SSE events shape stay frozen (back-compat).
 * No transport imports here — the embedded OpenCode host
 * (OpencodeHostService) is owned solely by the harness. The project directory
 * jail rides ProjectAccessService.resolveProjectDirectory.
 */
@Injectable()
export class SessionsService {
  constructor(private readonly harness: SessionHarnessService) {}

  /** GET /api/v1/sessions?projectId — list scoped to the gated jail. */
  async list(userId: string, projectId: string | undefined, cid: string): Promise<Array<SessionInfo>> {
    return this.harness.list(userId, projectId, cid);
  }

  /** GET /api/v1/sessions/status?projectId — sessionId → derived runtime status. */
  async statusMap(
    userId: string,
    projectId: string | undefined,
    cid: string,
  ): Promise<SessionRunStatusMap> {
    return this.harness.statusMap(userId, projectId, cid);
  }

  /** POST /api/v1/sessions — create in the gated jail. */
  async create(userId: string, body: CreateSessionInput, cid: string): Promise<SessionInfo> {
    return this.harness.create(userId, body, cid);
  }

  /** GET /api/v1/sessions/{id}/messages — normalized domain rows. */
  async listMessages(
    userId: string,
    sessionId: string,
    projectId: string | undefined,
    limitRaw: string | undefined,
    cursor: string | undefined,
    cid: string,
  ): Promise<Array<SessionMessage>> {
    return this.harness.listMessages(userId, sessionId, projectId, limitRaw, cursor, cid);
  }

  /** POST /api/v1/sessions/{id}/messages — queue the prompt, answer the receipt. */
  async sendMessage(
    userId: string,
    sessionId: string,
    body: SendMessageInput,
    cid: string,
  ): Promise<SessionMessage> {
    return this.harness.sendMessage(userId, sessionId, body, cid);
  }

  /** GET /api/v1/sessions/events — SSE re-stream of domain frames (contract frozen). */
  async streamEvents(
    userId: string,
    projectId: string | undefined,
    cid: string,
    req: ExpressRequest,
    res: ExpressResponse,
  ): Promise<void> {
    return this.harness.streamEvents(userId, projectId, cid, req, res);
  }

  /** POST /api/v1/sessions/{id}/interrupt — honest {interrupted} answer. */
  async interrupt(
    userId: string,
    sessionId: string,
    body: InterruptSessionInput,
    cid: string,
  ): Promise<SessionInterruptResult> {
    return this.harness.interrupt(userId, sessionId, body, cid);
  }

  /** GET /api/v1/sessions/providers — runner provider inventory (gated jail). */
  async providers(userId: string, projectId: string | undefined, cid: string): Promise<Array<SessionRunnerProvider>> {
    return this.harness.providers(userId, projectId, cid);
  }

  /** GET /api/v1/sessions/models — runner model inventory (Go/Zen family). */
  async models(userId: string, projectId: string | undefined, cid: string): Promise<Array<{ id: string; name: string; providerID: string }>> {
    return this.harness.models(userId, projectId, cid);
  }

  /** POST /api/v1/sessions/{id}/fork — copy the durable thread up to a boundary. */
  async fork(
    userId: string,
    sessionId: string,
    body: SessionForkRequest,
    cid: string,
  ): Promise<SessionForkResponse> {
    return this.harness.fork(userId, sessionId, body, cid);
  }

  /** POST /api/v1/sessions/{id}/revert/stage — restore + diff the boundary turn. */
  async stageRevert(
    userId: string,
    sessionId: string,
    body: RevertStageRequest,
    cid: string,
  ): Promise<RevertInfo> {
    return this.harness.stageRevert(userId, sessionId, body, cid);
  }

  /** DELETE /api/v1/sessions/{id}/revert — discard the staged revert. */
  async clearRevert(
    userId: string,
    sessionId: string,
    projectId: string | undefined,
    cid: string,
  ): Promise<void> {
    return this.harness.clearRevert(userId, sessionId, projectId, cid);
  }

  /** POST /api/v1/sessions/{id}/revert/commit — keep the restored files. */
  async commitRevert(
    userId: string,
    sessionId: string,
    projectId: string | undefined,
    cid: string,
  ): Promise<void> {
    return this.harness.commitRevert(userId, sessionId, projectId, cid);
  }

  /** GET /api/v1/sessions/{id}/snapshots/diff?from&to — per-file diff rows. */
  async snapshotDiff(
    userId: string,
    sessionId: string,
    projectId: string | undefined,
    from: string,
    to: string,
    contextRaw: string | undefined,
    cid: string,
  ): Promise<Array<SnapshotDiff>> {
    return this.harness.snapshotDiff(userId, sessionId, projectId, from, to, contextRaw, cid);
  }
}
