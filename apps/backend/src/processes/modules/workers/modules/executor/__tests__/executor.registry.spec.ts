/**
 * ExecutorRegistry unit checks — self-contained runner (plain node:assert).
 *
 * Runs against COMPILED dist (same constraint as the other runners):
 *   `bun run build && bun dist/processes/modules/workers/modules/executor/__tests__/executor.registry.spec.js`
 * Also executes under `bun test dist` (top-level, throws on failure).
 *
 * Covers the step-level agent seam:
 * - resolve(null) → 'default';
 * - resolve('ask') → 'ask';
 * - resolve('ghost') → 'default' (unknown ids never fail a run);
 * - registering a duplicate id throws instead of overwriting.
 */
import 'reflect-metadata';
import assert from 'node:assert/strict';
import type { AppLogger } from '../../../../../../common/logger';
import { ModelGatewayExecutor } from '../executor';
import { ExecutorRegistry } from '../executor.registry';
import { ModelGateway, type ModelEvent, type ModelRequest } from '../../model-gateway';

class FakeGateway extends ModelGateway {
  async *stream(_req: ModelRequest): AsyncIterable<ModelEvent> {
    yield { type: 'delta', text: 'fake' };
    yield { type: 'done', usage: { in: 0, out: 1 } };
  }
}

const logger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
} as unknown as AppLogger;

function makeRegistry(): ExecutorRegistry {
  return new ExecutorRegistry(new FakeGateway(), logger);
}

const checks: Array<{ name: string; run: () => void }> = [
  {
    name: 'resolve(null) → default executor',
    run: () => {
      assert.equal(makeRegistry().resolve(null).id, 'default');
    },
  },
  {
    name: "resolve('ask') → ask executor",
    run: () => {
      assert.equal(makeRegistry().resolve('ask').id, 'ask');
    },
  },
  {
    name: "resolve('ghost') → default (unknown never fails a run)",
    run: () => {
      assert.equal(makeRegistry().resolve('ghost').id, 'default');
    },
  },
  {
    name: 'duplicate executor id throws',
    run: () => {
      const registry = makeRegistry();
      assert.throws(
        () => registry.register(new ModelGatewayExecutor('ask', new FakeGateway())),
        /duplicate executor id ask/,
      );
    },
  },
  {
    name: 'registry wires ask + default over the gateway',
    run: () => {
      assert.deepEqual(makeRegistry().listIds(), ['ask', 'default']);
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
    console.error(`${failed}/${checks.length} executor registry checks failed`);
    process.exitCode = 1;
    throw new Error(`${failed}/${checks.length} executor registry checks failed`);
  }
  console.log(`${checks.length}/${checks.length} executor registry checks passed`);
}

main();
