import assert from 'node:assert/strict';

import { SessionsController } from '../sessions.controller';

type Case = { name: string; run: () => Promise<void> | void };

const cases: Array<Case> = [];
let currentSuite = '';

function describe(name: string, fn: () => void): void {
  currentSuite = name;
  fn();
  currentSuite = '';
}

function it(name: string, run: () => Promise<void> | void): void {
  cases.push({ name: currentSuite ? `${currentSuite} :: ${name}` : name, run });
}

function controller(service: Record<string, unknown>): SessionsController {
  return new SessionsController(service as never);
}

const IDENTITY = { id: 'uid-1' } as never;

describe('SessionsController branches', () => {
  it('GET messages forwards leafId to the active chain', async () => {
    let seen: unknown;
    const svc = controller({
      listMessages: async (...args: Array<unknown>): Promise<Array<unknown>> => {
        seen = args;
        return [{ id: 'root' }, { id: 'c' }];
      },
    });
    const out = await svc.messages(IDENTITY, 'sid', 'pid', undefined, undefined, 'leaf-c', 'cid');
    assert.deepEqual(
      (out as Array<{ id: string }>).map((row) => row.id),
      ['root', 'c'],
    );
    assert.equal((seen as Array<unknown>)[6], 'leaf-c');
  });

  it('GET variants forwards parentId and POST messages/revert answers the leaf', async () => {
    const variantsSvc = controller({
      listVariants: async (): Promise<Array<unknown>> => [{ childId: 'b' }, { childId: 'c' }],
    });
    const variants = await variantsSvc.variants(IDENTITY, 'sid', 'pid', 'root', 'cid');
    assert.equal(variants.length, 2);

    const revertSvc = controller({
      revertMessages: async (): Promise<unknown> => ({ activeLeaf: 'root' }),
    });
    const out = await revertSvc.revertMessages(
      IDENTITY,
      'sid',
      { projectId: 'pid', messageID: 'b' },
      'cid',
    );
    assert.deepEqual(out, { activeLeaf: 'root' });
  });
});

async function main(): Promise<void> {
  let failed = 0;
  for (const c of cases) {
    try {
      await c.run();
      console.log(`ok - ${c.name}`);
    } catch (error) {
      failed += 1;
      console.error(`FAIL - ${c.name}: ${(error as Error).message}`);
    }
  }
  console.log(`\n${cases.length - failed}/${cases.length} checks passed`);
  if (failed > 0) process.exitCode = 1;
}

void main().catch((error: unknown) => {
  console.error(`sessions controller checks failed: ${(error as Error).message}`);
  process.exit(1);
});
