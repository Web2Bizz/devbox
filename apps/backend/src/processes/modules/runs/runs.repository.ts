import { Injectable } from '@nestjs/common';
import { and, asc, desc, eq, gt, isNull, sql } from 'drizzle-orm';
import { type DbClient, DbService, dbUnavailable } from '@common/db/db.service';
import {
  type RunEventRow,
  type RunRow,
  type RunStepRow,
  runEvents,
  runLeases,
  runRuns,
  runSteps,
} from '@common/db/schema';
import { AppLogger } from '@common/logger';
import type { RunInfo } from './runs.dto';
import { GENESIS_HASH, nextPrevHash } from './utils/event-chain';

/** POST /api/v1/runs row input (correlationId is log-only, never persisted). */
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

/** Thrown when the lease is no longer ours (another worker claimed it). */
export class RunLeaseFencedError extends Error {
  constructor(readonly runId: string) {
    super(`run ${runId} lease is not held by this worker`);
    this.name = 'RunLeaseFencedError';
  }
}

/** Write-ahead step opening: recorded BEFORE the effect runs (ADR-0001 §9.1). */
export type RunStepStartInput = {
  runId: string;
  seq: number;
  /** llm.call | tool.call | sandbox.exec | git.commit | router */
  type: string;
  inputHash: string;
  /** hash(run_id, step_id, effect_class, input_hash) — one row per effect. */
  idempotencyKey: string;
  holder: string;
  leaseTtlMs: number;
  correlationId: string;
};

/** Step closing: outcome of an effect that already happened. */
export type RunStepFinishInput = {
  runId: string;
  seq: number;
  holder: string;
  leaseTtlMs: number;
  correlationId: string;
  resultRef?: Record<string, unknown>;
  error?: Record<string, unknown>;
};

/**
 * Drizzle transaction handle. Journal appends and the rows they describe must
 * commit together, so every mutating method threads this through instead of
 * reaching for the pool client.
 */
type RunTx = Parameters<Parameters<DbClient['transaction']>[0]>[0];

/**
 * RunsRepository — the ONLY place the runs domain touches drizzle.
 *
 * createRun writes the run row, its genesis `run_events` row and the lease
 * row in ONE transaction: a run that exists without a journal head or a
 * lease row would be invisible to the (E4) claim loop, so the three are one
 * unit. Every method funnels Postgres failures through `dbUnavailable` (503
 * EXTERNAL_UNAVAILABLE, logged once with the caller correlationId) — no silent
 * in-memory fallback.
 *
 * The claim loop story is the mirror image: claimNextRun takes an expired
 * lease (SKIP LOCKED, so two workers never take the same run), heartbeat
 * renews it, and the step methods (start/commit/fail) re-assert ownership
 * inside the SAME transaction as the journal append. A lost lease surfaces
 * as RunLeaseFencedError — the one error that is NOT a Postgres outage and
 * therefore never maps to 503: the worker simply stops.
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
    const runId: string = input.runId;
    try {
      return await this.db.client.transaction(async (tx: RunTx) => {
        const rows: Array<RunRow> = await tx
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
    } catch (error) {
      dbUnavailable('runs.createRun', error, this.logger, input.correlationId);
    }
  }

  /** Live (non-soft-deleted) run row; null when unknown. */
  async findRun(id: string, correlationId: string): Promise<RunRow | null> {
    try {
      const rows: Array<RunRow> = await this.db.client
        .select()
        .from(runRuns)
        .where(and(eq(runRuns.id, id), isNull(runRuns.deletedAt)))
        .limit(1);
      return rows.length > 0 ? rows[0] : null;
    } catch (error) {
      dbUnavailable('runs.findRun', error, this.logger, correlationId);
    }
  }

  /** Project-scoped live runs, newest first (GET /api/v1/runs). */
  async listRuns(projectId: string, correlationId: string): Promise<Array<RunRow>> {
    try {
      return await this.db.client
        .select()
        .from(runRuns)
        .where(and(eq(runRuns.projectId, projectId), isNull(runRuns.deletedAt)))
        .orderBy(desc(runRuns.createdAt));
    } catch (error) {
      dbUnavailable('runs.listRuns', error, this.logger, correlationId);
    }
  }

  /**
   * Journal rows after `afterSeq` in seq order — the SSE catch-up source
   * (append-only, so `seq > cursor` can never skip or duplicate a frame).
   */
  async listEventsAfter(
    runId: string,
    afterSeq: number,
    correlationId: string,
  ): Promise<Array<RunEventRow>> {
    try {
      return await this.db.client
        .select()
        .from(runEvents)
        .where(and(eq(runEvents.runId, runId), gt(runEvents.seq, afterSeq)))
        .orderBy(asc(runEvents.seq));
    } catch (error) {
      dbUnavailable('runs.listEventsAfter', error, this.logger, correlationId);
    }
  }

  /**
   * Takes the oldest expired lease among live 'open'/'running' runs and hands
   * the run to `holder` for `leaseTtlMs`.
   *
   * One transaction: the SELECT locks the lease row with SKIP LOCKED, so two
   * workers racing the same tick pick different runs instead of serializing
   * (or double-claiming) one. null means "nothing to do", not an error.
   */
  async claimNextRun(holder: string, leaseTtlMs: number, correlationId: string): Promise<RunRow | null> {
    try {
      return await this.db.client.transaction(async (tx: RunTx) => {
        // TODO(full-fencing): claim with an epoch bump and a holder check in
        // this same transaction (a stale epoch must fence the old worker).
        const claimed: { rows: Array<{ run_id?: string }> } = (await tx.execute(sql`
          SELECT rl.run_id
          FROM run_leases rl
          JOIN run_runs r ON r.id = rl.run_id
          WHERE rl.expires_at < now()
            AND r.deleted_at IS NULL
            AND r.status IN ('open', 'running')
          ORDER BY rl.expires_at ASC
          LIMIT 1
          FOR UPDATE OF rl SKIP LOCKED
        `)) as unknown as { rows: Array<{ run_id?: string }> };
        const runId: string | undefined = claimed.rows[0]?.run_id;
        if (!runId) return null;
        await tx.execute(sql`
          UPDATE run_leases
          SET holder = ${holder},
              expires_at = now() + make_interval(secs => ${leaseTtlMs / 1000})
          WHERE run_id = ${runId}
        `);
        const rows: Array<RunRow> = await tx
          .select()
          .from(runRuns)
          .where(eq(runRuns.id, runId))
          .limit(1);
        return rows.length > 0 ? rows[0] : null;
      });
    } catch (error) {
      dbUnavailable('runs.claimNextRun', error, this.logger, correlationId);
    }
  }

  /**
   * Renews our lease. false means the lease is gone (claimed by another
   * worker or reaped) — the caller must stop working on this run, it is NOT
   * a Postgres outage.
   */
  async heartbeat(
    runId: string,
    holder: string,
    leaseTtlMs: number,
    correlationId: string,
  ): Promise<boolean> {
    try {
      const renewed: { rows: Array<{ run_id?: string }> } = (await this.db.client.execute(sql`
        UPDATE run_leases
        SET expires_at = now() + make_interval(secs => ${leaseTtlMs / 1000})
        WHERE run_id = ${runId} AND holder = ${holder}
        RETURNING run_id
      `)) as unknown as { rows: Array<{ run_id?: string }> };
      return renewed.rows.length > 0;
    } catch (error) {
      dbUnavailable('runs.heartbeat', error, this.logger, correlationId);
    }
  }

  /** Steps of one run in seq order (crash recovery reads what was journaled). */
  async listSteps(runId: string, correlationId: string): Promise<Array<RunStepRow>> {
    try {
      return await this.db.client
        .select()
        .from(runSteps)
        .where(eq(runSteps.runId, runId))
        .orderBy(asc(runSteps.seq));
    } catch (error) {
      dbUnavailable('runs.listSteps', error, this.logger, correlationId);
    }
  }

  /**
   * Opens (or re-opens, after a crash) a step BEFORE its effect runs, and
   * journals `run.step.started` in the same transaction.
   *
   * The run row is locked first: journal seq is read-then-inserted, so the
   * lock is what keeps concurrent appends of one run from colliding on
   * (run_id, seq). A replayed step bumps `attempt` instead of duplicating the
   * row — `idempotency_key` still identifies the effect itself.
   */
  async startStep(input: RunStepStartInput): Promise<{ step: RunStepRow; event: RunEventRow }> {
    try {
      return await this.db.client.transaction(async (tx: RunTx) => {
        await this.lockRunTx(tx, input.runId);
        await this.assertLeaseTx(tx, input.runId, input.holder, input.leaseTtlMs);
        const existing: Array<RunStepRow> = await tx
          .select()
          .from(runSteps)
          .where(and(eq(runSteps.runId, input.runId), eq(runSteps.seq, input.seq)))
          .limit(1);
        const step: RunStepRow =
          existing.length > 0
            ? (
                await tx
                  .update(runSteps)
                  .set({
                    status: 'running',
                    attempt: existing[0].attempt + 1,
                    startedAt: new Date(),
                  })
                  .where(eq(runSteps.id, existing[0].id))
                  .returning()
              )[0]
            : (
                await tx
                  .insert(runSteps)
                  .values({
                    id: Bun.randomUUIDv7(),
                    runId: input.runId,
                    seq: input.seq,
                    type: input.type,
                    status: 'running',
                    attempt: 1,
                    inputHash: input.inputHash,
                    idempotencyKey: input.idempotencyKey,
                    observedEpoch: 0,
                    startedAt: new Date(),
                  })
                  .returning()
              )[0];
        const event: RunEventRow = await this.appendEventTx(tx, input.runId, 'run.step.started', {
          step: { id: step.id, seq: input.seq, type: input.type },
        });
        return { step, event };
      });
    } catch (error) {
      if (error instanceof RunLeaseFencedError) throw error;
      dbUnavailable('runs.startStep', error, this.logger, input.correlationId);
    }
  }

  /**
   * Closes a step as committed and journals its result reference.
   *
   * TODO(dual-write-reconcile): git effects (git.commit) are replayed onto the
   * branch/worktree in E4.1b; this method only closes the step row, the journal
   * stays the source of truth.
   */
  async commitStep(input: RunStepFinishInput): Promise<RunEventRow> {
    try {
      return await this.db.client.transaction(async (tx: RunTx) => {
        await this.lockRunTx(tx, input.runId);
        await this.assertLeaseTx(tx, input.runId, input.holder, input.leaseTtlMs);
        const resultRef: Record<string, unknown> = input.resultRef ?? {};
        await tx
          .update(runSteps)
          .set({ status: 'committed', resultRef, endedAt: sql`now()` })
          .where(and(eq(runSteps.runId, input.runId), eq(runSteps.seq, input.seq)));
        const event: RunEventRow = await this.appendEventTx(tx, input.runId, 'run.step.committed', {
          step: { seq: input.seq },
          resultRef,
        });
        // A committed step proves the run is in flight (it may have been
        // 'open' right after the claim).
        await tx
          .update(runRuns)
          .set({ status: 'running', updatedAt: sql`now()` })
          .where(eq(runRuns.id, input.runId));
        // Release the lease so the next prototype step is claimable
        // immediately; the next tick re-claims and re-asserts ownership in the
        // step transaction (TODO(full-fencing): epoch fencing later).
        await tx.execute(sql`
          UPDATE run_leases
          SET expires_at = now()
          WHERE run_id = ${input.runId} AND holder = ${input.holder}
        `);
        return event;
      });
    } catch (error) {
      if (error instanceof RunLeaseFencedError) throw error;
      dbUnavailable('runs.commitStep', error, this.logger, input.correlationId);
    }
  }

  /**
   * Closes a step as failed and journals the error.
   *
   * Run status is NOT touched: whether the failure is retryable (retry the
   * step) or terminal (fail/abort the run) is the claim loop's decision.
   *
   * TODO(dual-write-reconcile): partial git effects are reconciled in E4.1b.
   */
  async failStep(input: RunStepFinishInput): Promise<RunEventRow> {
    try {
      return await this.db.client.transaction(async (tx: RunTx) => {
        await this.lockRunTx(tx, input.runId);
        await this.assertLeaseTx(tx, input.runId, input.holder, input.leaseTtlMs);
        const error: Record<string, unknown> = input.error ?? {};
        await tx
          .update(runSteps)
          .set({ status: 'failed', error, endedAt: sql`now()` })
          .where(and(eq(runSteps.runId, input.runId), eq(runSteps.seq, input.seq)));
        const event: RunEventRow = await this.appendEventTx(tx, input.runId, 'run.step.failed', {
          step: { seq: input.seq },
          error,
        });
        await tx
          .update(runRuns)
          .set({ updatedAt: sql`now()` })
          .where(eq(runRuns.id, input.runId));
        return event;
      });
    } catch (error) {
      if (error instanceof RunLeaseFencedError) throw error;
      dbUnavailable('runs.failStep', error, this.logger, input.correlationId);
    }
  }

  /**
   * Parks the run for a human (`awaiting_human`) or marks it terminally
   * `failed` when nothing can be advanced anymore. Either way the lease is
   * held for a day, so no worker re-claims it while the decision is pending.
   * Resuming is a later epic (the lease simply expires and the claim loop
   * picks it up).
   */
  async finishRun(
    runId: string,
    holder: string,
    status: 'awaiting_human' | 'failed',
    correlationId: string,
  ): Promise<void> {
    try {
      await this.db.client.transaction(async (tx: RunTx) => {
        await this.lockRunTx(tx, runId);
        await tx.execute(sql`
          UPDATE run_leases
          SET expires_at = now() + interval '24 hours'
          WHERE run_id = ${runId} AND holder = ${holder}
        `);
        await tx
          .update(runRuns)
          .set({ status, updatedAt: sql`now()` })
          .where(eq(runRuns.id, runId));
      });
    } catch (error) {
      dbUnavailable('runs.finishRun', error, this.logger, correlationId);
    }
  }

  /**
   * Serializes journal appends of one run. The run row lock is taken before
   * the seq read, so two transactions can never compute the same `seq`.
   */
  private async lockRunTx(tx: RunTx, runId: string): Promise<void> {
    await tx.execute(sql`SELECT id FROM run_runs WHERE id = ${runId} FOR UPDATE`);
  }

  /**
   * Lease guard: extends our still-held lease or fences the worker. An empty
   * RETURNING means the lease now belongs to someone else — a fenced worker
   * must stop instead of writing a second history for the run.
   */
  private async assertLeaseTx(
    tx: RunTx,
    runId: string,
    holder: string,
    leaseTtlMs: number,
  ): Promise<void> {
    const renewed: { rows: Array<{ run_id?: string }> } = (await tx.execute(sql`
      UPDATE run_leases
      SET expires_at = now() + make_interval(secs => ${leaseTtlMs / 1000})
      WHERE run_id = ${runId} AND holder = ${holder}
      RETURNING run_id
    `)) as unknown as { rows: Array<{ run_id?: string }> };
    if (renewed.rows.length === 0) throw new RunLeaseFencedError(runId);
  }

  /**
   * Appends one journal row onto the hash chain and wakes SSE subscribers.
   *
   * `pg_notify` rides the caller's transaction: it is delivered only if the
   * append commits, so no subscriber can tail a row that rolled back. The
   * seq read + insert are safe because every caller already holds the run row
   * lock (lockRunTx) in this transaction.
   */
  private async appendEventTx(
    tx: RunTx,
    runId: string,
    type: string,
    data: Record<string, unknown>,
  ): Promise<RunEventRow> {
    const last: Array<RunEventRow> = await tx
      .select()
      .from(runEvents)
      .where(eq(runEvents.runId, runId))
      .orderBy(desc(runEvents.seq))
      .limit(1);
    const previous: RunEventRow | null = last[0] ?? null;
    const seq: number = previous ? Number(previous.seq) + 1 : 1;
    // An empty journal still starts from genesis (createRun normally owns
    // that row; a run without one must not chain onto a fake predecessor).
    const prevHash: string = previous ? nextPrevHash(previous) : GENESIS_HASH;
    const inserted: Array<RunEventRow> = await tx
      .insert(runEvents)
      .values({ runId, seq, type, data, prevHash })
      .returning();
    await tx.execute(sql`SELECT pg_notify('run_events', ${runId})`);
    return inserted[0];
  }
}
