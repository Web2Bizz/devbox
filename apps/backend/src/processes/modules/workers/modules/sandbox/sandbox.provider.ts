import { Injectable } from '@nestjs/common';
import type { RunRow } from '../../../../../common/db/schema';
import { ExternalServiceError } from '../../../../../common/external/external-error';
import { AppLogger } from '../../../../../common/logger';
import { serveBasicAuthHeader } from '../../../../modules/ai/modules/opencode/modules/auth/serve-auth.service';
import { OpencodeService } from '../../../../modules/ai/modules/opencode/opencode.service';

/** Fixed messages (external-error.ts keeps its map private; same strings, no upstream echo). */
const MESSAGES = {
  unauthorized: 'внутренняя авторизация в вышестоящем сервисе не пройдена',
  badRequest: 'вышестоящий сервис отклонил запрос как некорректный',
  notFound: 'ресурс не найден на вышестоящем сервисе',
  unavailable: 'сервис временно недоступен, повторите позже',
} as const;

/**
 * SandboxProvider — one command in the per-run sandbox, executed by the
 * opencode runner (the only exec surface of the prototype).
 *
 * The runner owns the isolated working copy: `POST /api/session` creates a
 * session pinned to the run worktree, then `POST /api/session/:id/shell`
 * runs the command inside it. Auth is the server Basic header (never logged),
 * failures map to the same EXTERNAL_* codes as every other upstream call so
 * the claim loop journals a fixed step error.
 *
 * TODO(no-per-run-resources): quotas are shared (one compose service) —
 * per-run cgroups / microVM isolation are out of the prototype; the runner
 * only isolates the worktree, not CPU/memory/network.
 */
@Injectable()
export class SandboxProvider {
  constructor(
    private readonly opencode: OpencodeService,
    private readonly logger: AppLogger = new AppLogger(SandboxProvider.name),
  ) {}

  /**
   * Creates the run session and executes one shell command in it.
   * Returns the upstream session id plus the parsed shell payload (the
   * runner owns the shape — the journal stores it as the step result).
   */
  async exec(
    run: RunRow,
    command: string,
    cid: string,
  ): Promise<{ sessionId: string; output: unknown }> {
    const headers: Record<string, string> = {
      ...serveBasicAuthHeader(),
      'content-type': 'application/json',
    };
    if (cid) headers['x-correlation-id'] = cid;
    const base = this.opencode.dialUrl();

    const created = await this.opencode.fetchWithRetry(
      `${base}/api/session`,
      {
        method: 'POST',
        headers,
        body: JSON.stringify({
          location: { directory: run.worktree },
          title: `run ${run.id}`,
        }),
      },
      { operation: 'sandboxCreate' },
    );
    if (!created.ok) {
      // Drain before throwing so the socket is not left half-read.
      await created.arrayBuffer().catch(() => null);
      this.logger.warn(`[workers] sandbox.exec create failed status=${created.status}`, cid);
      throw this.mapError('sandboxCreate', created.status);
    }

    const createdBody = (await created.json().catch(() => null)) as {
      data?: { id?: string };
    } | null;
    const sessionId = createdBody?.data?.id;
    if (typeof sessionId !== 'string' || sessionId.length === 0) {
      this.logger.warn('[workers] sandbox.exec create returned no session id', cid);
      throw this.mapError('sandboxCreate', 502);
    }

    const shell = await this.opencode.fetchWithRetry(
      `${base}/api/session/${encodeURIComponent(sessionId)}/shell`,
      {
        method: 'POST',
        headers,
        body: JSON.stringify({ command, directory: run.worktree }),
      },
      { operation: 'sandboxShell' },
    );
    if (!shell.ok) {
      await shell.arrayBuffer().catch(() => null);
      this.logger.warn(`[workers] sandbox.exec shell failed status=${shell.status}`, cid);
      throw this.mapError('sandboxShell', shell.status);
    }

    const output = await shell.json().catch(() => null);
    this.logger.info(`[workers] sandbox.exec session=${sessionId} ok`, cid);
    return { sessionId, output };
  }

  /**
   * Upstream status → fixed EXTERNAL_* code. 401/403 mean OUR credentials were
   * refused (never retry), 400/404/422 are request-level answers (never
   * retry), everything else is an outage and only 5xx is worth one more try.
   */
  private mapError(operation: string, status: number): ExternalServiceError {
    if (status === 401 || status === 403) {
      return new ExternalServiceError({
        code: 'EXTERNAL_UNAUTHORIZED',
        service: 'opencode',
        operation,
        message: MESSAGES.unauthorized,
        status,
        isRetryable: false,
      });
    }
    if (status === 400 || status === 422) {
      return new ExternalServiceError({
        code: 'EXTERNAL_BAD_REQUEST',
        service: 'opencode',
        operation,
        message: MESSAGES.badRequest,
        status,
        isRetryable: false,
      });
    }
    if (status === 404) {
      return new ExternalServiceError({
        code: 'EXTERNAL_NOT_FOUND',
        service: 'opencode',
        operation,
        message: MESSAGES.notFound,
        status,
        isRetryable: false,
      });
    }
    return new ExternalServiceError({
      code: 'EXTERNAL_UNAVAILABLE',
      service: 'opencode',
      operation,
      message: MESSAGES.unavailable,
      status,
      isRetryable: status >= 500,
    });
  }
}
