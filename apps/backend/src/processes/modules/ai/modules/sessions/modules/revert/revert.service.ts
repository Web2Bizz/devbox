import { Injectable, NotFoundException } from '@nestjs/common';
import { AppLogger } from '@common/logger';
import { ExternalServiceError } from '@common/external/external-error';
import { SessionHistoryRepository } from '../../session-history.repository';
import type { SnapshotDiff } from '../../sessions.dto';
import { SnapshotsService, type RestoreEntry } from '../snapshots/snapshots.service';

export type RevertStageCommand = {
  sessionId: string;
  /** Gated project content directory (git worktree root or nested path). */
  directory: string;
  messageID: string;
  files?: Array<string>;
};

type StagedRevert = {
  messageID: string;
  snapshot: string;
  directory: string;
  files: Array<SnapshotDiff>;
  /** Pre-stage tree per changed path — clear() restores exactly this. */
  originals: Array<RestoreEntry>;
};

/**
 * RevertService — staged file revert on top of SnapshotsService.
 *
 * A turn records the snapshot taken BEFORE it started (the harness calls
 * `recordTurnStart`); `stage` restores the boundary turn's snapshot and
 * answers the diffs it produced. `clear` restores the pre-stage tree,
 * `commit` only drops the staged state. Unknown boundary messages answer
 * MessageNotFound; a project without git snapshots answers an honest error
 * (restore is strict, capture is best-effort by design).
 */
@Injectable()
export class RevertService {
  private readonly logger: AppLogger = new AppLogger(RevertService.name);
  /** `${sessionId}\0${messageID}` → pre-turn tree. */
  private readonly turnStarts: Map<string, string> = new Map<string, string>();
  private readonly staged: Map<string, StagedRevert> = new Map<string, StagedRevert>();

  constructor(
    private readonly history: SessionHistoryRepository,
    private readonly snapshots: SnapshotsService,
  ) {}

  /** Remember the tree captured before a turn (best-effort, undefined skips). */
  recordTurnStart(sessionId: string, messageID: string, snapshot?: string): void {
    if (!snapshot) return;
    this.turnStarts.set(`${sessionId}\0${messageID}`, snapshot);
  }

  async stage(command: RevertStageCommand): Promise<{
    messageID: string;
    snapshot: string | null;
    files: Array<SnapshotDiff>;
  }> {
    const messages: Array<{ id: string }> = await this.history.listMessages(command.sessionId);
    const index: number = messages.findIndex((message) => message.id === command.messageID);
    if (index < 0) {
      throw new NotFoundException({
        code: 'MessageNotFound',
        message: `Message '${command.messageID}' not found in session`,
      });
    }
    const snapshot: string | undefined = this.findSnapshot(command.sessionId, messages, index);
    if (!snapshot) {
      this.logger.info('[revert] stage skipped code=no_snapshot', '');
      return { messageID: command.messageID, snapshot: null, files: [] };
    }
    // Restaging: put the previous revert back first (files return to the
    // real current state), never stack two originals.
    await this.clear(command.sessionId).catch(() => undefined);
    const current: string | undefined = await this.snapshots.capture(command.directory);
    if (!current) {
      this.logger.warn('[revert] stage failed code=snapshot_unavailable');
      throw new ExternalServiceError({
        code: 'EXTERNAL_UNAVAILABLE',
        service: 'snapshots',
        operation: 'revertStage',
        message: 'сервис временно недоступен, повторите позже',
        isRetryable: true,
        cause: new Error('not_a_git_repository'),
      });
    }
    const changed: Array<SnapshotDiff> = await this.snapshots.diff(
      command.directory,
      snapshot,
      current,
      undefined,
      command.files,
    );
    await this.snapshots.restore(
      command.directory,
      changed.map((file) => ({ path: file.file, snapshot })),
    );
    this.staged.set(command.sessionId, {
      messageID: command.messageID,
      snapshot,
      directory: command.directory,
      files: changed,
      originals: changed.map((file) => ({ path: file.file, snapshot: current })),
    });
    this.logger.info(`[revert] staged files=${changed.length}`);
    return { messageID: command.messageID, snapshot, files: changed };
  }

  /** Discard the staged revert: files return to their pre-stage tree. */
  async clear(sessionId: string): Promise<void> {
    const staged: StagedRevert | undefined = this.staged.get(sessionId);
    if (!staged) return;
    await this.snapshots.restore(staged.directory, staged.originals);
    this.staged.delete(sessionId);
    this.logger.info('[revert] cleared');
  }

  /** Keep the restored files, drop the staged state. */
  async commit(sessionId: string): Promise<void> {
    if (!this.staged.delete(sessionId)) return;
    this.logger.info('[revert] committed');
  }

  /** Pre-turn snapshot of the boundary message (walk back to the nearest turn). */
  private findSnapshot(
    sessionId: string,
    messages: Array<{ id: string }>,
    index: number,
  ): string | undefined {
    for (let cursor: number = index; cursor >= 0; cursor -= 1) {
      const message: { id: string } | undefined = messages[cursor];
      if (!message) continue;
      const snapshot: string | undefined = this.turnStarts.get(`${sessionId}\0${message.id}`);
      if (snapshot) return snapshot;
    }
    return undefined;
  }
}
