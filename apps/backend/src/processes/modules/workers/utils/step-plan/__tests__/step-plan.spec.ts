/**
 * step-plan util unit checks — self-contained runner (plain node:assert).
 *
 * Runs against COMPILED dist (same constraint as the other runners):
 *   `bun run build && bun dist/processes/modules/workers/utils/step-plan/__tests__/step-plan.spec.js`
 * Also executes under `bun test dist` (top-level run, throws on failure).
 *
 * Covers the crash-recovery decision:
 * - an empty journal starts at step 1;
 * - a committed step advances to the next one;
 * - a running step is retried (write-ahead row without a committed effect);
 * - a failed step stops the pipeline (null), never silently skips it;
 * - seq 3 is sandbox.exec and seq 4 is git.commit;
 * - all committed → null and isComplete() true;
 * - bigint seq values (Postgres bigint mode) match numbers.
 */
import assert from 'node:assert/strict';
import { PROTOTYPE_STEPS, isComplete, nextStep } from '..';

const checks: Array<{ name: string; run: () => void }> = [
  {
    name: 'empty journal → step 1',
    run: () => {
      assert.deepEqual(nextStep([]), PROTOTYPE_STEPS[0]);
      assert.equal(isComplete([]), false);
    },
  },
  {
    name: 'step 1 committed → step 2',
    run: () => {
      assert.deepEqual(nextStep([{ seq: 1, status: 'committed' }]), PROTOTYPE_STEPS[1]);
    },
  },
  {
    name: 'step 2 running → step 2 (retry)',
    run: () => {
      assert.deepEqual(
        nextStep([
          { seq: 1, status: 'committed' },
          { seq: 2, status: 'running' },
        ]),
        PROTOTYPE_STEPS[1],
      );
    },
  },
  {
    name: 'step 1 failed → null (terminal for the prototype)',
    run: () => {
      assert.equal(nextStep([{ seq: 1, status: 'failed' }]), null);
      assert.equal(isComplete([{ seq: 1, status: 'failed' }]), false);
    },
  },
  {
    name: 'steps 1,2,3 committed → git.commit (step 4)',
    run: () => {
      assert.deepEqual(
        nextStep([
          { seq: 1, status: 'committed' },
          { seq: 2, status: 'committed' },
          { seq: 3, status: 'committed' },
        ]),
        PROTOTYPE_STEPS[3],
      );
      assert.equal(PROTOTYPE_STEPS[3]?.type, 'git.commit');
      assert.equal(PROTOTYPE_STEPS[2]?.type, 'sandbox.exec');
    },
  },
  {
    name: 'all committed → null + isComplete true',
    run: () => {
      const all = PROTOTYPE_STEPS.map((step) => ({ seq: step.seq, status: 'committed' }));
      assert.equal(nextStep(all), null);
      assert.equal(isComplete(all), true);
    },
  },
  {
    name: 'bigint seq is matched like number seq',
    run: () => {
      assert.deepEqual(
        nextStep([
          { seq: 1n, status: 'committed' },
          { seq: 2n, status: 'committed' },
        ]),
        PROTOTYPE_STEPS[2],
      );
    },
  },
];

function main(): void {
  let failed = 0;
  for (const c of checks) {
    try {
      c.run();
      console.log(`ok - ${c.name}`);
    } catch (err) {
      failed += 1;
      console.error(`FAIL - ${c.name}: ${(err as Error).message}`);
    }
  }
  if (failed > 0) {
    console.error(`${failed}/${checks.length} step-plan checks failed`);
    process.exitCode = 1;
    throw new Error(`${failed}/${checks.length} step-plan checks failed`);
  }
  console.log(`${checks.length}/${checks.length} step-plan checks passed`);
}

main();
