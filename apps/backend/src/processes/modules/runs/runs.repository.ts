import { Injectable } from '@nestjs/common';
import { and, asc, eq, gt, isNull } from 'drizzle-orm';
import { DbService, dbUnavailable } from '../../../common/db/db.service';
import {
  type RunEventRow,
  type RunRow,
  runEvents,
  runLeases,
  runRuns,
} from '../../../common/db/schema';
import { AppLogger } from '../../../common/logger';
import type { RunInfo } from './runs.dto';

/** POST /api/runs row input (correlationId is log-only, never persisted). */
export type CreateRunRowInput = {
  /** Pre-minted by the service — the SAME id the branch/worktree names derive from. */
  runId: string;
  projectId: string;
  title: string | null;
  definitionSetHash: string;
  baseCommit: string;
  branch: string;
  worktree: string;
  agentId: string | null;
  model: RunInfo['model'];
  correlationId: string;
};

/**
 * RunsRepository — the ONLY place the runs domain touches drizzle.
 *
 * createRun writes the run row, its genesis `run_events` row and the lease
 * row in ONE transaction: a run that exists without a journal head or a
 * lease row would be invisible to the (E4) claim loop, so the three are one
 * unit. Every method funnels Postgres failures through `dbUnavailable` (503
 * EXTERNAL_UNAVAILABLE, logged once with the caller cid) — no silent
 * in-memory fallback.
 */
@Injectable()
export class RunsRepository {
  constructor(
    private readonly db: DbService,
    private readonly logger: AppLogger = new AppLogger(RunsRepository.name),
  ) {}

  /**
   * Creates a run open for the claim loop: the row (status 'open'), its
   * genesis journal event (`seq` 1, prevHash 'genesis') and a lease row that
   * is already expired — so a worker may claim it immediately.
   *
   * The id comes from the caller because the contract derives the agent branch
   * (`agent/<run_id>`) and the worktree (`…/wt/<run_id>`) from it — minting a
   * second id here would break that 1:1 naming.
   */
  async createRun(input: CreateRunRowInput): Promise<RunRow> {
    const runId = input.runId;
    try {
      return await this.db.client.transaction(async (tx) => {
        const rows = await tx
          .insert(runRuns)
          .values({
            id: runId,
            projectId: input.projectId,
            title: input.title,
            status: 'open',
            definitionSetHash: input.definitionSetHash,
            baseCommit: input.baseCommit,
            branch: input.branch,
            worktree: input.worktree,
            sandboxId: null,
            agentId: input.agentId,
            model: input.model,
          })
          .returning();
        // Journal head: every later event chains onto this row (E4 continues
        // the prevHash chain); status mirrors the row so a replay can rebuild
        // the run's opening state without a second read.
        await tx.insert(runEvents).values({
          runId,
          seq: 1,
          type: 'run.started',
          data: {
            projectId: input.projectId,
            branch: input.branch,
            baseCommit: input.baseCommit,
            worktree: input.worktree,
            definitionSetHash: input.definitionSetHash,
            status: 'open',
          },
          prevHash: 'genesis',
        });
        // Expired on purpose: the claim loop sees the work right away.
        // TODO(full-fencing): claim with SELECT ... FOR UPDATE + epoch on this
        // row in the same transaction as the journal append.
        await tx.insert(runLeases).values({
          runId,
          holder: 'pending',
          expiresAt: new Date(0),
        });
        return rows[0];
      });
    } catch (err) {
      dbUnavailable('runs.createRun', err, this.logger, input.correlationId);
    }
  }

  /** Live (non-soft-deleted) run row; null when unknown. */
  async findRun(id: string, cid: string): Promise<RunRow | null> {
    try {
      const rows = await this.db.client
        .select()
        .from(runRuns)
        .where(and(eq(runRuns.id, id), isNull(runRuns.deletedAt)))
        .limit(1);
      return rows.length > 0 ? rows[0] : null;
    } catch (err) {
      dbUnavailable('runs.findRun', err, this.logger, cid);
    }
  }

  /**
   * Journal rows after `afterSeq` in seq order — the SSE catch-up source
   * (append-only, so `seq > cursor` can never skip or duplicate a frame).
   */
  async listEventsAfter(
    runId: string,
    afterSeq: number,
    cid: string,
  ): Promise<Array<RunEventRow>> {
    try {
      return await this.db.client
        .select()
        .from(runEvents)
        .where(and(eq(runEvents.runId, runId), gt(runEvents.seq, afterSeq)))
        .orderBy(asc(runEvents.seq));
    } catch (err) {
      dbUnavailable('runs.listEventsAfter', err, this.logger, cid);
    }
  }
}
