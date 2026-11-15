import { Injectable, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import type { ToolView } from '@rush-code/contracts';
import { createHash, randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import { canonicalJson } from '@common/canonical-json/canonical-json';
import type { RunRow, RunStepRow } from '@common/db/schema';
import { AppLogger, serializeCause } from '@common/logger';
import { RunLeaseFencedError, RunsRepository } from '../../../runs/runs.repository';
import { isComplete, nextStep, type PrototypeStep } from '../../utils/step-plan';
import { type Executor } from '../executor/executor';
import { ExecutorRegistry } from '../executor/executor.registry';
import { RunWorktreeService } from '../git/run-worktree.service';
import type { ModelMessage, ModelUsage } from '../model-gateway/model-gateway';
import { SandboxProvider } from '../sandbox/sandbox.provider';
import { type SkillBundle } from '../skills/skill.types';
import { SkillLoader } from '../skills/skills-loader.service';
import { ToolRegistry, type ToolInvokeResult } from '../tool-registry/tool-registry';

/** Lease is renewed by every step transaction; this is the ceiling between renewals. */
const LEASE_TTL_MS: number = 15_000;
/** Idle poll cadence when there is no run to claim. */
const POLL_MS: number = 250;
/** Backoff after a tick failure (Postgres blip, unexpected error). */
const ERROR_BACKOFF_MS: number = 2_000;

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

/**
 * RunsClaimLoop — the in-process run engine of the prototype.
 *
 * One tick claims the oldest expired lease (SKIP LOCKED, so two workers never
 * take the same run), materializes the run worktree, and advances the fixed
 * `llm.call → tool.call → sandbox.exec → git.commit` plan one step at a time.
 * Every step is opened write-ahead and closed by RunsRepository, whose lease guard
 * (`assertLeaseTx`) renews our lease inside the SAME transaction as the
 * journal append — a lost lease surfaces as RunLeaseFencedError and the worker
 * stops instead of writing a second history. All steps committed → the run is
 * parked for a human (`awaiting_human`); an unrecoverable step failure leaves
 * the run visible as failed, never silently retried.
 *
 * The llm.call step resolves its definition set from `run.definitionSetHash`
 * (`sha256:<base_commit>`): skills are read strictly at that commit through the
 * SkillLoader, so an in-flight run never sees a fresher SKILL.md, and the
 * filtered ToolView surface is deny-by-default per each skill's `allowed-tools`.
 * The executed agent comes from ExecutorRegistry by `run.agentId` (null →
 * default); the journal records model/text/usage plus the pinned skills and
 * their effects.
 *
 * TODO(full-fencing): epoch-based fencing (a stale worker must be fenced by
 * the lease row itself, not just by the holder string).
 * TODO(dual-write-reconcile): git effects are not replayed by a reconcile
 * job yet; a failed git.commit is terminal for the prototype.
 */
@Injectable()
export class RunsClaimLoop implements OnModuleInit, OnModuleDestroy {
  private readonly holder: string = `${hostname()}:${process.pid}:${randomUUID()}`;
  private stopped: boolean = false;
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly repo: RunsRepository,
    private readonly worktree: RunWorktreeService,
    private readonly executors: ExecutorRegistry,
    private readonly tools: ToolRegistry,
    private readonly sandbox: SandboxProvider,
    private readonly skills: SkillLoader,
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
      let worked: boolean = false;
      try {
        worked = await this.tick();
      } catch (error) {
        // A fenced worker is expected (another worker owns the run now) and
        // already logged by tick(); everything else is an outage/unexpected.
        if (!(error instanceof RunLeaseFencedError)) {
          this.logger.error('[workers] tick failed', '');
          this.logger.debug(serializeCause(error), '');
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
    const run: RunRow | null = await this.repo.claimNextRun(this.holder, LEASE_TTL_MS, '');
    if (!run) return false;
    try {
      await this.advance(run);
    } catch (error) {
      if (error instanceof RunLeaseFencedError) {
        this.logger.warn('[workers] lease lost', '');
        return true;
      }
      this.logger.error('[workers] advance failed', '');
      this.logger.debug(serializeCause(error), '');
    }
    return true;
  }

  /** Moves one run to its next step (or parks/fails it). */
  private async advance(run: RunRow): Promise<void> {
    try {
      await this.worktree.ensure(run, '');
    } catch (error) {
      if (error instanceof RunLeaseFencedError) throw error;
      // Without a worktree nothing can run; fail the run instead of leaving it
      // claimed-but-stuck (the lease expires and the loop would spin on it).
      this.logger.error('[workers] worktree failed', '');
      this.logger.debug(serializeCause(error), '');
      await this.repo.finishRun(run.id, this.holder, 'failed', '');
      return;
    }

    const steps: Array<RunStepRow> = await this.repo.listSteps(run.id, '');
    const step: PrototypeStep | null = nextStep(steps);
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
    else if (step.type === 'sandbox.exec') await this.runSandbox(run, step);
    else await this.runGitCommit(run, step);
  }

  private async runLlm(run: RunRow, step: PrototypeStep): Promise<void> {
    const model: string =
      run.model && typeof run.model.id === 'string' ? run.model.id : 'stub-model';
    const messages: Array<ModelMessage> = [
      { role: 'user', content: run.title ?? 'prototype run' },
    ];
    const definitionSetHash: string = run.definitionSetHash;
    // definitionSetHash is `sha256:<base_commit>`; a run created without an
    // explicit pin falls back to its own Forward-Only base — never the worktree
    // HEAD, so the pin can only move forward by creating a new run.
    const commitSha: string = definitionSetHash.startsWith('sha256:')
      ? definitionSetHash.slice('sha256:'.length)
      : run.baseCommit;

    // Skills are resolved BEFORE the step opens: inputHash names the pinned
    // definition set, so a journaled llm.call is replayable against the exact
    // SKILL.md bodies the model saw.
    let bundle: SkillBundle;
    try {
      bundle = await this.skills.loadForRun(run.worktree, commitSha);
    } catch (error) {
      if (error instanceof RunLeaseFencedError) throw error;
      // Detail stays in debug; the journal gets a fixed code, no body.
      this.logger.debug(serializeCause(error), '');
      const inputHash: string = sha256(canonicalJson({ model, messages, definitionSetHash }));
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
      await this.repo.failStep({
        runId: run.id,
        seq: step.seq,
        holder: this.holder,
        leaseTtlMs: LEASE_TTL_MS,
        correlationId: '',
        error: { code: 'SKILL_LOAD_FAILED', message: 'skill load failed' },
      });
      await this.repo.finishRun(run.id, this.holder, 'failed', '');
      return;
    }

    // Deny-by-default: an active skill narrows the model-facing surface to its
    // `allowed-tools`; the model never sees effects or handlers (D3).
    const tools: Array<ToolView> = this.skills.filterToolViews(this.tools.listViews(), bundle);
    const executor: Executor = this.executors.resolve(run.agentId);

    const inputHash: string = sha256(canonicalJson({ model, messages, definitionSetHash }));

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
      let text: string = '';
      let usage: ModelUsage = { inputTokens: 0, outputTokens: 0 };
      for await (const event of executor.stream({
        model,
        system: bundle.system,
        messages,
        tools,
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
        resultRef: {
          model,
          text,
          usage,
          definitionSetHash,
          skills: bundle.skills.map((skill) => skill.meta.name),
          effects: bundle.effects,
        },
      });
    } catch (error) {
      if (error instanceof RunLeaseFencedError) throw error;
      // Detail (possibly provider-shaped) stays in debug; the journal gets a
      // fixed code, never a body or a secret.
      this.logger.debug(serializeCause(error), '');
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
    const toolId: string = step.toolId ?? 'native:git.recon';
    const inputHash: string = sha256(canonicalJson({ toolId, path: run.worktree }));

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
      const result: ToolInvokeResult = await this.tools.invoke(
        toolId,
        { path: run.worktree },
        { cwd: run.worktree },
      );
      await this.repo.commitStep({
        runId: run.id,
        seq: step.seq,
        holder: this.holder,
        leaseTtlMs: LEASE_TTL_MS,
        correlationId: '',
        resultRef: { toolId, ...result },
      });
    } catch (error) {
      if (error instanceof RunLeaseFencedError) throw error;
      this.logger.debug(serializeCause(error), '');
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

  private async runSandbox(run: RunRow, step: PrototypeStep): Promise<void> {
    const command: string = 'echo run-ready';
    const inputHash: string = sha256(
      canonicalJson({ baseCommit: run.baseCommit, worktree: run.worktree, command }),
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
      const result: Awaited<ReturnType<SandboxProvider['exec']>> = await this.sandbox.exec(
        run,
        command,
        '',
      );
      await this.repo.commitStep({
        runId: run.id,
        seq: step.seq,
        holder: this.holder,
        leaseTtlMs: LEASE_TTL_MS,
        correlationId: '',
        resultRef: { sessionId: result.sessionId, command, output: result.output },
      });
    } catch (error) {
      if (error instanceof RunLeaseFencedError) throw error;
      // Upstream detail (possibly body-shaped) stays in debug; the journal
      // gets a fixed code, never a command output or a secret.
      this.logger.debug(serializeCause(error), '');
      await this.repo.failStep({
        runId: run.id,
        seq: step.seq,
        holder: this.holder,
        leaseTtlMs: LEASE_TTL_MS,
        correlationId: '',
        error: { code: 'SANDBOX_EXEC_FAILED', message: 'sandbox.exec failed' },
      });
      // Terminal for the prototype: no auto-retry after a failed step
      // (TODO(dual-write-reconcile)); the operator sees the failed run.
      await this.repo.finishRun(run.id, this.holder, 'failed', '');
    }
  }

  private async runGitCommit(run: RunRow, step: PrototypeStep): Promise<void> {
    const inputHash: string = sha256(
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
      const { sha, branch }: { sha: string; branch: string } = await this.worktree.commit(
        run,
        step.seq,
        '',
      );
      await this.repo.commitStep({
        runId: run.id,
        seq: step.seq,
        holder: this.holder,
        leaseTtlMs: LEASE_TTL_MS,
        correlationId: '',
        resultRef: { sha, branch, baseCommit: run.baseCommit },
      });
    } catch (error) {
      if (error instanceof RunLeaseFencedError) throw error;
      this.logger.debug(serializeCause(error), '');
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

  private sleep(milliseconds: number): Promise<void> {
    return new Promise<void>((resolve) => {
      const timer: ReturnType<typeof setTimeout> = setTimeout(() => {
        if (this.timer === timer) this.timer = null;
        resolve();
      }, milliseconds);
      this.timer = timer;
    });
  }
}
