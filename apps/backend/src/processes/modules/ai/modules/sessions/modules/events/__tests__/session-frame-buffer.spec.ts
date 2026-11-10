import assert from 'node:assert/strict';
import { SessionFrameBufferService } from '../session-frame-buffer.service';

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

function idsOf(frames: ReadonlyArray<{ id: string }>): Array<string> {
  return frames.map((frame) => frame.id);
}

describe('SessionFrameBufferService', () => {
  it('bounds the buffer at 500 frames, dropping the oldest', () => {
    const buffer = new SessionFrameBufferService();
    for (let i = 0; i < 501; i += 1) {
      buffer.pushFrame({ id: `f${i}`, type: 'message.part.delta', data: {} });
    }
    assert.equal(buffer.length(), 500);
    assert.equal(buffer.list()[0]?.id, 'f1');
    assert.equal(buffer.list()[499]?.id, 'f500');
  });

  it('push assigns unique non-empty ids', () => {
    const buffer = new SessionFrameBufferService();
    for (let i = 0; i < 8; i += 1) {
      buffer.push('message.part.delta', { index: i });
    }
    const ids = idsOf(buffer.list());
    assert.equal(ids.length, 8);
    assert.equal(new Set(ids).size, ids.length);
    assert.ok(ids.every((id) => id.length > 0));
  });

  it('keeps live identity: appends after list() are visible', () => {
    const buffer = new SessionFrameBufferService();
    buffer.pushFrame({ id: 'a', type: 'message.part.delta', data: {} });
    const live = buffer.list();
    assert.equal(live.length, 1);
    buffer.pushFrame({ id: 'b', type: 'message.part.delta', data: {} });
    assert.equal(live.length, 2);
    assert.equal(buffer.list(), live);
  });

  it('replays the whole buffer for an undefined or unknown cursor', () => {
    const buffer = new SessionFrameBufferService();
    buffer.pushFrame({ id: 'a', type: 'text', data: { sessionID: 's1' } });
    buffer.pushFrame({ id: 'b', type: 'tool', data: { sessionID: 's1' } });
    buffer.pushFrame({ id: 'c', type: 'text', data: { sessionID: 's1' } });

    const all = buffer.replayAfter(undefined, () => true);
    assert.equal(all.cursorIndex, -1);
    assert.deepEqual(idsOf(all.frames), ['a', 'b', 'c']);

    const unknown = buffer.replayAfter('missing', () => true);
    assert.equal(unknown.cursorIndex, -1);
    assert.deepEqual(idsOf(unknown.frames), ['a', 'b', 'c']);
  });

  it('replays only frames after a known cursor', () => {
    const buffer = new SessionFrameBufferService();
    buffer.pushFrame({ id: 'a', type: 'text', data: { sessionID: 's1' } });
    buffer.pushFrame({ id: 'b', type: 'tool', data: { sessionID: 's1' } });
    buffer.pushFrame({ id: 'c', type: 'text', data: { sessionID: 's1' } });

    const afterA = buffer.replayAfter('a', () => true);
    assert.equal(afterA.cursorIndex, 0);
    assert.deepEqual(idsOf(afterA.frames), ['b', 'c']);

    const afterLast = buffer.replayAfter('c', () => true);
    assert.equal(afterLast.cursorIndex, 2);
    assert.deepEqual(idsOf(afterLast.frames), []);
  });

  it('applies the keep filter after the cursor', () => {
    const buffer = new SessionFrameBufferService();
    buffer.pushFrame({ id: 'a', type: 'text', data: { sessionID: 's1' } });
    buffer.pushFrame({ id: 'b', type: 'tool', data: { sessionID: 's1' } });
    buffer.pushFrame({ id: 'c', type: 'text', data: { sessionID: 's2' } });

    const textOnly = buffer.replayAfter(undefined, (frame) => frame.type === 'text');
    assert.deepEqual(idsOf(textOnly.frames), ['a', 'c']);

    const afterA = buffer.replayAfter('a', (frame) => frame.type === 'text');
    assert.deepEqual(idsOf(afterA.frames), ['c']);
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
  console.error(`session frame buffer checks failed to run: ${(err as Error).message}`);
  process.exit(1);
});
