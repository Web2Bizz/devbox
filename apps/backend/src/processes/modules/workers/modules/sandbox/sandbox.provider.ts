import { Injectable } from '@nestjs/common';
import type { RunRow } from '@common/db/schema';
import { ExternalServiceError } from '@common/external/external-error';
import { AppLogger } from '@common/logger';
import {
  type HostSessionInfo,
  type OpencodeHost,
  OpencodeHostService,
} from '../../../../modules/ai/modules/opencode/opencode-host.service';

/** Fixed messages (external-error.ts keeps its map private; same strings, no upstream echo). */
type SandboxMessages = { readonly unavailable: string };

const MESSAGES: SandboxMessages = {
  unavailable: 'сервис временно недоступен, повторите позже',
};

/**
 * SandboxProvider — one command in the per-run sandbox, executed by the
 * embedded OpenCode host (in-process; no HTTP, no Basic auth).
 *
 * Each run step gets one in-process SDK session pinned to the run worktree
 * (`sessions.create`), then `sessions.shell({ sessionID, command })` runs the
 * command inside it. Failures map to EXTERNAL_UNAVAILABLE so the claim loop
 * journals a fixed step error.
 *
 * TODO(no-per-run-resources): quotas are shared (one embedded host per
 * backend process) — per-run cgroups / microVM isolation are out of the
 * prototype; the host only isolates the worktree, not CPU/memory/network.
 */
@Injectable()
export class SandboxProvider {
  constructor(
    private readonly host: OpencodeHostService,
    private readonly logger: AppLogger = new AppLogger(SandboxProvider.name),
  ) {}

  /**
   * Creates the run session and executes one shell command in it.
   * Returns the host session id plus the command payload (the journal stores
   * it as the step result).
   */
  async exec(
    run: RunRow,
    command: string,
    correlationId: string,
  ): Promise<{ sessionId: string; output: unknown }> {
    try {
      const host: OpencodeHost = await this.host.getHost();
      const session: HostSessionInfo = await host.sessions.create({
        location: { directory: run.worktree },
        title: `run ${run.id}`,
      });
      await host.sessions.shell({ sessionID: session.id, command });
      this.logger.info(`[workers] sandbox.exec session=${session.id} ok`, correlationId);
      return { sessionId: session.id, output: { command } };
    } catch (error) {
      if (error instanceof ExternalServiceError) throw error;
      this.logger.warn('[workers] sandbox.exec failed', correlationId);
      this.logger.debug((error as Error).message, correlationId);
      throw new ExternalServiceError({
        code: 'EXTERNAL_UNAVAILABLE',
        service: 'opencode',
        operation: 'sandbox.exec',
        message: MESSAGES.unavailable,
        isRetryable: true,
        cause: error,
      });
    }
  }
}
