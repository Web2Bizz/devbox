/**
 * event-chain util unit checks — self-contained runner (plain node:assert).
 *
 * Runs against COMPILED dist (same constraint as the other runners):
 *   `bun run build && bun dist/processes/modules/runs/utils/event-chain/__tests__/event-chain.spec.js`
 * Also executes under `bun test dist` (top-level run, throws on failure).
 *
 * Covers the journal chain link `hashRunEvent` / `nextPrevHash`:
 * - an empty journal starts from GENESIS_HASH;
 * - the same input hashes identically (a replay must reproduce the chain);
 * - changing data/seq/type/prevHash changes the hash (tamper evidence);
 * - object key order does not change the hash (canonical jsonb projection);
 * - a number seq and the same bigint seq hash alike;
 * - nextPrevHash(row) is exactly hashRunEvent(row).
 */
import assert from 'node:assert/strict';
import { GENESIS_HASH, hashRunEvent, nextPrevHash } from '..';

type ChainRow = {
  seq: number | bigint;
  type: string;
  prevHash: string;
  data: unknown;
};

/** Baseline row: the shape the repository reads back from `run_events`. */
function row(overrides: Partial<ChainRow> = {}): ChainRow {
  return {
    seq: 1,
    type: 'run.started',
    prevHash: GENESIS_HASH,
    data: { projectId: 'p1', status: 'open' },
    ...overrides,
  };
}

const chains: Array<{ name: string; run: () => void }> = [
  {
    name: 'nextPrevHash(null) → genesis',
    run: () => {
      assert.equal(nextPrevHash(null), GENESIS_HASH);
      assert.equal(GENESIS_HASH, 'genesis');
    },
  },
  {
    name: 'same input → same hash (deterministic)',
    run: () => {
      assert.equal(hashRunEvent(row()), hashRunEvent(row()));
    },
  },
  {
    name: 'hash is a sha256 hex digest',
    run: () => {
      const hash = hashRunEvent(row());
      assert.match(hash, /^[0-9a-f]{64}$/);
    },
  },
  {
    name: 'changing data changes the hash; key order does not (canonical)',
    run: () => {
      const base = hashRunEvent(row());
      const changed = hashRunEvent(row({ data: { projectId: 'p1', status: 'running' } }));
      assert.notEqual(changed, base);
      // jsonb reorders object keys on read — the canonical projection keeps
      // the same digest, so a stored/reloaded event still chains.
      const reordered = hashRunEvent(row({ data: { status: 'open', projectId: 'p1' } }));
      assert.equal(reordered, base);
    },
  },
  {
    name: 'changing seq changes the hash',
    run: () => {
      assert.notEqual(hashRunEvent(row({ seq: 2 })), hashRunEvent(row({ seq: 1 })));
    },
  },
  {
    name: 'changing prevHash changes the hash',
    run: () => {
      assert.notEqual(hashRunEvent(row({ prevHash: 'deadbeef' })), hashRunEvent(row()));
    },
  },
  {
    name: 'changing type changes the hash',
    run: () => {
      assert.notEqual(
        hashRunEvent(row({ type: 'run.step.started' })),
        hashRunEvent(row({ type: 'run.started' })),
      );
    },
  },
  {
    name: 'number and bigint seq hash alike',
    run: () => {
      assert.equal(hashRunEvent(row({ seq: 5n })), hashRunEvent(row({ seq: 5 })));
    },
  },
  {
    name: 'nextPrevHash(row) === hashRunEvent(row)',
    run: () => {
      const last = row({ seq: 3, type: 'run.step.committed', data: { step: { seq: 2 } } });
      assert.equal(nextPrevHash(last), hashRunEvent(last));
    },
  },
  {
    name: 'next row chains onto the previous hash',
    run: () => {
      const first = row();
      const second = row({ seq: 2, type: 'run.step.started', prevHash: nextPrevHash(first) });
      assert.equal(second.prevHash, hashRunEvent(first));
      assert.notEqual(hashRunEvent(second), hashRunEvent(first));
    },
  },
];

function main(): void {
  let failed = 0;
  for (const c of chains) {
    try {
      c.run();
      console.log(`ok - ${c.name}`);
    } catch (err) {
      failed += 1;
      console.error(`FAIL - ${c.name}: ${(err as Error).message}`);
    }
  }
  if (failed > 0) {
    console.error(`${failed}/${chains.length} event-chain checks failed`);
    process.exitCode = 1;
    throw new Error(`${failed}/${chains.length} event-chain checks failed`);
  }
  console.log(`${chains.length}/${chains.length} event-chain checks passed`);
}

main();
