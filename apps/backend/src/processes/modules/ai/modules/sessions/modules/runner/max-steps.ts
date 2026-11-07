/** Hard step budget of one turn — a model loop never runs unbounded. */
export const DEFAULT_MAX_STEPS = 12;

/** Raised when a turn exceeds the budget (no silent truncation). */
export class MaxStepsExceededError extends Error {
  constructor(readonly maxSteps: number) {
    super(`max-steps-exceeded:${maxSteps}`);
    this.name = 'MaxStepsExceededError';
  }
}

/** Throws MaxStepsExceededError when the next step index is out of budget. */
export function assertStepBudget(stepIndex: number, maxSteps: number = DEFAULT_MAX_STEPS): void {
  if (!Number.isInteger(maxSteps) || maxSteps < 1) {
    throw new Error('maxSteps must be a positive integer');
  }
  if (stepIndex >= maxSteps) throw new MaxStepsExceededError(maxSteps);
}
