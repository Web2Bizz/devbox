import { Injectable, Optional } from '@nestjs/common';
import { AppLogger } from '@common/logger';
import type { RevertInfo, SnapshotDiff } from '../../sessions.dto';
import { RevertService, type RevertStageCommand } from '../revert/revert.service';
import { SnapshotsService } from '../snapshots/snapshots.service';

/**
 * TurnWorkspaceService — the sessions domain's git-backed workspace zone.
 *
 * The ONLY sessions component that touches SnapshotsService/RevertService
 * (pre-turn trees, staged revert, snapshot diffs). Capture is best-effort by
 * design (a turn never fails because a snapshot could not be taken); revert
 * and diff are strict and answer an honest Error when the git services are
 * not wired (hand-wired specs).
 */
@Injectable()
export class TurnWorkspaceService {
  constructor(
    @Optional() private readonly snapshots?: SnapshotsService,
    @Optional() private readonly revert?: RevertService,
    private readonly logger: AppLogger = new AppLogger(TurnWorkspaceService.name),
  ) {}

  /** Best-effort pre-turn tree (undefined on non-git / disabled / failure). */
  async capture(directory: string, correlationId: string): Promise<string | undefined> {
    if (!this.snapshots) return undefined;
    try {
      return await this.snapshots.capture(directory);
    } catch (error) {
      this.logger.warn('[sessions] snapshot skipped', correlationId);
      this.logger.debug((error as Error).message, correlationId);
      return undefined;
    }
  }

  /** Capture before a turn and remember it by the user receipt id. */
  async captureBeforeTurn(
    directory: string,
    sessionId: string,
    messageID: string,
    correlationId: string,
  ): Promise<void> {
    const snapshot: string | undefined = await this.capture(directory, correlationId);
    if (snapshot) this.recordTurnStart(sessionId, messageID, snapshot);
  }

  /** Remember the tree captured before a turn (best-effort, undefined skips). */
  recordTurnStart(sessionId: string, messageID: string, snapshot?: string): void {
    this.revert?.recordTurnStart(sessionId, messageID, snapshot);
  }

  /** Restore + diff the boundary turn's snapshot (staged revert). */
  async stage(input: RevertStageCommand, correlationId: string): Promise<RevertInfo> {
    if (!this.revert) throw new Error('RevertService is not wired');
    const info: RevertInfo = await this.revert.stage({
      sessionId: input.sessionId,
      directory: input.directory,
      messageID: input.messageID,
      ...(input.files !== undefined ? { files: input.files } : {}),
      ...(input.projectId !== undefined ? { projectId: input.projectId } : {}),
    });
    this.logger.info(`[sessions] revert staged files=${info.files.length}`, correlationId);
    return info;
  }

  /** Discard the staged revert (files return to their pre-stage tree). */
  async clear(sessionId: string, correlationId: string): Promise<void> {
    if (!this.revert) throw new Error('RevertService is not wired');
    await this.revert.clear(sessionId);
    this.logger.info('[sessions] revert cleared', correlationId);
  }

  /** Keep the restored files, drop the staged revert state. */
  async commit(sessionId: string, correlationId: string): Promise<void> {
    if (!this.revert) throw new Error('RevertService is not wired');
    await this.revert.commit(sessionId);
    this.logger.info('[sessions] revert committed', correlationId);
  }

  /** Per-file diffs between two captured trees. */
  async diff(
    directory: string,
    from: string,
    to: string,
    context: number | undefined,
    correlationId: string,
  ): Promise<Array<SnapshotDiff>> {
    if (!this.snapshots) throw new Error('SnapshotsService is not wired');
    const rows: Array<SnapshotDiff> = await this.snapshots.diff(directory, from, to, context);
    this.logger.info(`[sessions] snapshot diff files=${rows.length}`, correlationId);
    return rows;
  }
}
