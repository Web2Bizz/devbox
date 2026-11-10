import assert from 'node:assert/strict';
import { SessionRuntimeStateService } from '../session-runtime-state.service';

type Case = { name: string; run: () => Promise<void> | void };
const cases: Array<Case> = [];
let suite = '';

function describe(name: string, fn: () => void): void {
  suite = name;
  fn();
  suite = '';
}

function it(name: string, run: () => Promise<void> | void): void {
  cases.push({ name: suite ? `${suite} :: ${name}` : name, run });
}

describe('SessionRuntimeStateService', () => {
  it('tracks in-flight busy ids', () => {
    const state = new SessionRuntimeStateService();
    assert.equal(state.isBusy('a'), false);
    state.markBusy('a');
    state.markBusy('b');
    assert.equal(state.isBusy('a'), true);
    assert.deepEqual([...state.busyIds()].sort(), ['a', 'b']);
    assert.equal(state.clearBusy('a'), true);
    assert.equal(state.clearBusy('a'), false);
    assert.equal(state.isBusy('a'), false);
  });

  it('binds and unbinds host sessions', () => {
    const state = new SessionRuntimeStateService();
    const binding = { projectId: 'p1', localSessionId: 's1', userId: 'u1' };
    assert.equal(state.getHostBinding('host-1'), undefined);
    state.bindHostSession('host-1', binding);
    assert.deepEqual(state.getHostBinding('host-1'), binding);
    state.unbindHostSession('host-1');
    assert.equal(state.getHostBinding('host-1'), undefined);
  });

  it('stores and deletes per-turn meta', () => {
    const state = new SessionRuntimeStateService();
    const meta = { userId: 'u1', projectId: 'p1', agentId: 'auto', mode: 'auto' as const };
    assert.equal(state.getTurnMeta('s1'), undefined);
    state.setTurnMeta('s1', meta);
    assert.deepEqual(state.getTurnMeta('s1'), meta);
    state.deleteTurnMeta('s1');
    assert.equal(state.getTurnMeta('s1'), undefined);
  });
});

async function main(): Promise<void> {
  let failed = 0;
  for (const c of cases) {
    try {
      await c.run();
      console.log(`ok   - ${c.name}`);
    } catch (err) {
      failed += 1;
      console.error(`FAIL - ${c.name}: ${(err as Error).message}`);
    }
  }
  console.log(`\n${cases.length - failed}/${cases.length} checks passed`);
  if (failed > 0) process.exitCode = 1;
}

void main().catch((err: unknown) => {
  console.error(`session runtime state checks failed to run: ${(err as Error).message}`);
  process.exit(1);
});
