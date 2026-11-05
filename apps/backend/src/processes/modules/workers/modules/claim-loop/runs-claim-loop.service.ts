import { Injectable, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import { canonicalJson } from '../../../../../common/canonical-json';
import type { RunRow } from '../../../../../common/db/schema';
import { AppLogger, serializeCause } from '../../../../../common/logger';
import { RunLeaseFencedError, RunsRepository } from '../../../runs/runs.repository';
import { isComplete, nextStep, type PrototypeStep } from '../../utils/step-plan';
import { RunWorktreeService } from '../git';
import { ModelGateway, type ModelMessage } from '../model-gateway';
import { ToolRegistry } from '../tool-registry';

/** Lease is renewed by every step transaction; this is the ceiling between renewals. */
const LEASE_TTL_MS = 15_000;
/** Idle poll cadence when there is no run to claim. */
const POLL_MS = 250;
/** Backoff after a tick failure (Postgres blip, unexpected error). */
const ERROR_BACKOFF_MS = 2_000;

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

/**
 * RunsClaimLoop — the in-process run engine of the prototype.
 *
 * One tick claims the oldest expired lease (SKIP LOCKED, so two workers never
 * take the same run), materializes the run worktree, and advances the fixed
 * `llm.call → tool.call → git.commit` plan one step at a time. Every step is
 * opened write-ahead and closed by RunsRepository, whose lease guard
 * (`assertLeaseTx`) renews our lease inside the SAME transaction as the
 * journal append — a lost lease surfaces as RunLeaseFencedError and the worker
 * stops instead of writing a second history. All steps committed → the run is
 * parked for a human (`awaiting_human`); an unrecoverable step failure leaves
 * the run visible as failed, never silently retried.
 *
 * TODO(full-fencing): epoch-based fencing (a stale worker must be fenced by
 * the lease row itself, not just by the holder string).
 * TODO(dual-write-reconcile): git effects are not replayed by a reconcile
 * job yet; a failed git.commit is terminal for the prototype.
 */
@Injectable()
export class RunsClaimLoop implements OnModuleInit, OnModuleDestroy {
  private readonly holder = `${hostname()}:${process.pid}:${randomUUID()}`;
  private stopped = false;
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly repo: RunsRepository,
    private readonly worktree: RunWorktreeService,
    private readonly gateway: ModelGateway,
    private readonly tools: ToolRegistry,
    private readonly logger: AppLogger = new AppLogger(RunsClaimLoop.name),
  ) {}

  /** Starts the loop without blocking boot (no DB round-trip on the boot path). */
  onModuleInit(): void {
    this.stopped = false;
    void this.loop();
  }

  /** Graceful shutdown: stop after the current tick, never mid-commit. */
  onModuleDestroy(): void {
    this.stopped = true;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  private async loop(): Promise<void> {
    while (!this.stopped) {
      let worked = false;
      try {
        worked = await this.tick();
      } catch (err) {
        // A fenced worker is expected (another worker owns the run now) and
        // already logged by tick(); everything else is an outage/unexpected.
        if (!(err instanceof RunLeaseFencedError)) {
          this.logger.error('[workers] tick failed', '');
          this.logger.debug(serializeCause(err), '');
        }
        await this.sleep(ERROR_BACKOFF_MS);
        continue;
      }
      if (!worked) await this.sleep(POLL_MS);
    }
  }

  /**
   * One claim attempt. Public so the loop is unit-testable without timers.
   * true means a run was claimed (whether or not it advanced cleanly).
   */
  async tick(): Promise<boolean> {
    const run = await this.repo.claimNextRun(this.holder, LEASE_TTL_MS, '');
    if (!run) return false;
    try {
      await this.advance(run);
    } catch (err) {
      if (err instanceof RunLeaseFencedError) {
        this.logger.warn('[workers] lease lost', '');
        return true;
      }
      this.logger.error('[workers] advance failed', '');
      this.logger.debug(serializeCause(err), '');
    }
    return true;
  }

  /** Moves one run to its next step (or parks/fails it). */
  private async advance(run: RunRow): Promise<void> {
    try {
      await this.worktree.ensure(run, '');
    } catch (err) {
      if (err instanceof RunLeaseFencedError) throw err;
      // Without a worktree nothing can run; fail the run instead of leaving it
      // claimed-but-stuck (the lease expires and the loop would spin on it).
      this.logger.error('[workers] worktree failed', '');
      this.logger.debug(serializeCause(err), '');
      await this.repo.finishRun(run.id, this.holder, 'failed', '');
      return;
    }

    const steps = await this.repo.listSteps(run.id, '');
    const step = nextStep(steps);
    if (!step) {
      // All steps committed → park for a human. A failed/skipped step means
      // nothing can advance anymore → terminal failed (operator decides).
      await this.repo.finishRun(
        run.id,
        this.holder,
        isComplete(steps) ? 'awaiting_human' : 'failed',
        '',
      );
      return;
    }

    if (step.type === 'llm.call') await this.runLlm(run, step);
    else if (step.type === 'tool.call') await this.runTool(run, step);
    else await this.runGitCommit(run, step);
  }

  private async runLlm(run: RunRow, step: PrototypeStep): Promise<void> {
    const model = run.model && typeof run.model.id === 'string' ? run.model.id : 'stub-model';
    const messages: Array<ModelMessage> = [
      { role: 'user', content: run.title ?? 'prototype run' },
    ];
    const inputHash = sha256(canonicalJson({ model, messages }));

    await this.repo.startStep({
      runId: run.id,
      seq: step.seq,
      type: step.type,
      inputHash,
      idempotencyKey: sha256(`${run.id}|${step.seq}|${step.type}|${inputHash}`),
      holder: this.holder,
      leaseTtlMs: LEASE_TTL_MS,
      correlationId: '',
    });

    try {
      let text = '';
      let usage = { in: 0, out: 0 };
      for await (const event of this.gateway.stream({
        model,
        messages,
        tools: this.tools.listViews(),
        need: {},
      })) {
        if (event.type === 'delta') text += event.text;
        else if (event.type === 'done') usage = event.usage;
      }
      await this.repo.commitStep({
        runId: run.id,
        seq: step.seq,
        holder: this.holder,
        leaseTtlMs: LEASE_TTL_MS,
        correlationId: '',
        resultRef: { model, text, usage },
      });
    } catch (err) {
      if (err instanceof RunLeaseFencedError) throw err;
      // Detail (possibly provider-shaped) stays in debug; the journal gets a
      // fixed code, never a body or a secret.
      this.logger.debug(serializeCause(err), '');
      await this.repo.failStep({
        runId: run.id,
        seq: step.seq,
        holder: this.holder,
        leaseTtlMs: LEASE_TTL_MS,
        correlationId: '',
        error: { code: 'LLM_CALL_FAILED', message: 'llm.call failed' },
      });
      // Terminal for the prototype: no auto-retry after a failed step
      // (TODO(dual-write-reconcile)); the operator sees the failed run.
      await this.repo.finishRun(run.id, this.holder, 'failed', '');
    }
  }

  private async runTool(run: RunRow, step: PrototypeStep): Promise<void> {
    const toolId = step.toolId ?? 'native:git.recon';
    const inputHash = sha256(canonicalJson({ toolId, path: run.worktree }));

    await this.repo.startStep({
      runId: run.id,
      seq: step.seq,
      type: step.type,
      inputHash,
      idempotencyKey: sha256(`${run.id}|${step.seq}|${step.type}|${inputHash}`),
      holder: this.holder,
      leaseTtlMs: LEASE_TTL_MS,
      correlationId: '',
    });

    try {
      const result = await this.tools.invoke(toolId, { path: run.worktree }, { cwd: run.worktree });
      await this.repo.commitStep({
        runId: run.id,
        seq: step.seq,
        holder: this.holder,
        leaseTtlMs: LEASE_TTL_MS,
        correlationId: '',
        resultRef: { toolId, ...result },
      });
    } catch (err) {
      if (err instanceof RunLeaseFencedError) throw err;
      this.logger.debug(serializeCause(err), '');
      await this.repo.failStep({
        runId: run.id,
        seq: step.seq,
        holder: this.holder,
        leaseTtlMs: LEASE_TTL_MS,
        correlationId: '',
        error: { code: 'TOOL_CALL_FAILED', message: 'tool.call failed' },
      });
      // Terminal for the prototype: no auto-retry after a failed step
      // (TODO(dual-write-reconcile)); the operator sees the failed run.
      await this.repo.finishRun(run.id, this.holder, 'failed', '');
    }
  }

  private async runGitCommit(run: RunRow, step: PrototypeStep): Promise<void> {
    const inputHash = sha256(
      canonicalJson({ baseCommit: run.baseCommit, branch: run.branch, seq: step.seq }),
    );

    await this.repo.startStep({
      runId: run.id,
      seq: step.seq,
      type: step.type,
      inputHash,
      idempotencyKey: sha256(`${run.id}|${step.seq}|${step.type}|${inputHash}`),
      holder: this.holder,
      leaseTtlMs: LEASE_TTL_MS,
      correlationId: '',
    });

    try {
      const { sha, branch } = await this.worktree.commit(run, step.seq, '');
      await this.repo.commitStep({
        runId: run.id,
        seq: step.seq,
        holder: this.holder,
        leaseTtlMs: LEASE_TTL_MS,
        correlationId: '',
        resultRef: { sha, branch, baseCommit: run.baseCommit },
      });
    } catch (err) {
      if (err instanceof RunLeaseFencedError) throw err;
      this.logger.debug(serializeCause(err), '');
      // TODO(dual-write-reconcile): no auto-retry yet; the operator sees the
      // failed step in the journal and decides (prototype policy).
      await this.repo.failStep({
        runId: run.id,
        seq: step.seq,
        holder: this.holder,
        leaseTtlMs: LEASE_TTL_MS,
        correlationId: '',
        error: { code: 'GIT_COMMIT_FAILED', message: 'git.commit failed' },
      });
      // Terminal for the prototype: no auto-retry after a failed step
      // (TODO(dual-write-reconcile)); the operator sees the failed run.
      await this.repo.finishRun(run.id, this.holder, 'failed', '');
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        if (this.timer === timer) this.timer = null;
        resolve();
      }, ms);
      this.timer = timer;
    });
  }
}
