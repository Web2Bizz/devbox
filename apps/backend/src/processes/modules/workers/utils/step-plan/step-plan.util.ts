export type PrototypeStepType = 'llm.call' | 'tool.call' | 'git.commit';

export type PrototypeStep = { seq: number; type: PrototypeStepType; toolId?: string };

/**
 * The prototype run is a fixed three-step pipeline: ask the model, recon the
 * worktree, commit the result. The step rows are still written ahead and
 * journaled one by one, so a crash resumes exactly at the first uncommitted
 * step instead of replaying the whole plan.
 */
export const PROTOTYPE_STEPS: ReadonlyArray<PrototypeStep> = [
  { seq: 1, type: 'llm.call' },
  { seq: 2, type: 'tool.call', toolId: 'native:git.recon' },
  { seq: 3, type: 'git.commit' },
];

type ExistingStep = { seq: number | bigint; status: string };

/**
 * Next step to execute: missing/pending/running; null when failed/skipped or
 * all committed. A `pending`/`running` row is a retry — the write-ahead row
 * exists but its effect has not been committed yet.
 */
export function nextStep(existing: ReadonlyArray<ExistingStep>): PrototypeStep | null {
  const bySeq = new Map<number, ExistingStep>();
  for (const row of existing) bySeq.set(Number(row.seq), row);

  for (const step of PROTOTYPE_STEPS) {
    const row = bySeq.get(step.seq);
    if (!row) return step;
    if (row.status === 'committed') continue;
    if (row.status === 'failed' || row.status === 'skipped') return null;
    return step;
  }
  return null;
}

/** All prototype steps committed. */
export function isComplete(existing: ReadonlyArray<ExistingStep>): boolean {
  const bySeq = new Map<number, ExistingStep>();
  for (const row of existing) bySeq.set(Number(row.seq), row);
  return PROTOTYPE_STEPS.every((step) => bySeq.get(step.seq)?.status === 'committed');
}
