import assert from 'node:assert/strict';
import { NotFoundException } from '@nestjs/common';
import type { AppLogger } from '@common/logger';
import type { CryptoService } from '@common/crypto/crypto.service';
import type { VaultService } from '@common/vault/vault.service';
import type { OpencodeModelFetch } from '../../../../opencode/opencode-model-fetch';
import {
  ToolDispatchService,
} from '../../../../tool-dispatch/tool-dispatch.service';
import { ToolRegistryService } from '../../../../tool-registry/tool-registry.service';
import type { ToolContext } from '../../../../tool-runtime/tool-runtime.types';
import { SessionTurnRunnerService, type StepExecutor } from '../../runner/runner.service';
import { MaxStepsExceededError } from '../../runner/max-steps';
import type { LoopStep } from '../../runner/loop';
import { SessionFrameBufferService } from '../../events/session-frame-buffer.service';
import { SessionRuntimeStateService } from '../../state/session-runtime-state.service';
import { InProcessTurnService, IN_PROCESS_FAILED_MESSAGE } from '../in-process-turn.service';

/**
 * InProcessTurnService — the `auto` turn executed by rush-code itself.
 *
 * Covers: a tool-call step followed by the final text (durable user+assistant
 * rows, ordered live frames, the tool handler really runs), `ask` refusing a
 * mutating tool without running it, the missing-key 404 discarding the staged
 * user row (no failure frames), and an interrupt dropping the late answer.
 *
 * The model is a fake `StepExecutor`; the runner, dispatcher and registry are
 * the real ones, so the tool gate and the frame mapping are exercised.
 */
type Case = { name: string; run: () => Promise<void> };
const cases: Array<Case> = [];
let suite = '';

function describe(name: string, fn: () => void): void {
  suite = name;
  fn();
  suite = '';
}

function it(name: string, run: () => Promise<void>): void {
  cases.push({ name: suite ? `${suite} :: ${name}` : name, run });
}

const UID = '123e4567-e89b-12d3-a456-426614174001';
const SID = '123e4567-e89b-12d3-a456-426614174002';
const PID = '123e4567-e89b-12d3-a456-426614174003';
const DIR = '/tmp/repos/orgs/u/projects/p/content';

type AppendedRow = { id: string; role: string; text: string | null; kind?: string; name?: string; status?: string; parentId?: string | null };

type Harness = {
  service: InProcessTurnService;
  state: SessionRuntimeStateService;
  buffer: SessionFrameBufferService;
  appended: Array<AppendedRow>;
  discarded: Array<string>;
  readCalls: () => number;
  writeCalls: () => number;
};

/** Fake executor answering the scripted steps in order (last step repeats). */
function fakeStep(script: Array<LoopStep>): StepExecutor {
  let index = 0;
  return async (): Promise<LoopStep> => {
    const step: LoopStep = script[Math.min(index, script.length - 1)] as LoopStep;
    index += 1;
    return step;
  };
}

function silentLogger(): AppLogger {
  const noop = (): void => undefined;
  return {
    debug: noop,
    info: noop,
    log: noop,
    warn: noop,
    error: noop,
    fatal: noop,
  } as unknown as AppLogger;
}

function harness(step: StepExecutor): Harness {
  const appended: Array<AppendedRow> = [];
  const discarded: Array<string> = [];
  let readCount = 0;
  let writeCount = 0;

  const registry = new ToolRegistryService();
  registry.register({
    fullName: 'read',
    definition: { name: 'read', description: 'read', inputSchema: { type: 'object' } },
    execute: async (_input: unknown, _context: ToolContext): Promise<string> => {
      readCount += 1;
      return 'file content';
    },
  });
  registry.register({
    fullName: 'write',
    definition: { name: 'write', description: 'write', inputSchema: { type: 'object' } },
    execute: async (_input: unknown, _context: ToolContext): Promise<string> => {
      writeCount += 1;
      return 'wrote';
    },
  });
  const dispatch = new ToolDispatchService(registry);
  const runner = new SessionTurnRunnerService(dispatch);
  const state = new SessionRuntimeStateService();
  const buffer = new SessionFrameBufferService();
  const history = {
    async setAgent(): Promise<void> {},
    async appendMessage(row: AppendedRow & { role: 'user' | 'assistant' | 'tool' | 'reasoning' }): Promise<void> {
      appended.push({ id: row.id, role: row.role, text: row.text ?? '', kind: row.kind, name: row.name, status: row.status, parentId: row.parentId ?? null });
    },
    async discardMessage(id: string): Promise<void> {
      discarded.push(id);
    },
  };
  const workspace = {
    async captureBeforeTurn(): Promise<void> {},
  };
  const keys = {} as VaultService;
  const crypto = {} as CryptoService;
  const opencodeFetch = {} as OpencodeModelFetch;

  class TestInProcessTurnService extends InProcessTurnService {
    protected override buildStep(): StepExecutor {
      return step;
    }
  }

  const service = new TestInProcessTurnService(
    history as unknown as ConstructorParameters<typeof InProcessTurnService>[0],
    workspace as unknown as ConstructorParameters<typeof InProcessTurnService>[1],
    state,
    buffer,
    runner,
    registry,
    dispatch,
    keys,
    crypto,
    opencodeFetch,
    silentLogger(),
  );

  return {
    service,
    state,
    buffer,
    appended,
    discarded,
    readCalls: (): number => readCount,
    writeCalls: (): number => writeCount,
  };
}

function body(mode?: 'auto' | 'ask'): { projectId: string; text: string; mode?: 'auto' | 'ask' } {
  return { projectId: PID, text: 'сделай', ...(mode !== undefined ? { mode } : {}) };
}

const TOOL_STEP: LoopStep = {
  text: '',
  calls: [{ id: 'c1', name: 'read', arguments: '{"path":"a"}' }],
  finishReason: 'tool-calls',
};

const FINAL_STEP: LoopStep = { text: 'готово', calls: [], finishReason: 'stop' };

describe('InProcessTurnService', () => {
  it('auto: tool call then final text — durable user+assistant, ordered frames', async () => {
    const h = harness(fakeStep([TOOL_STEP, FINAL_STEP]));
    const receipt = await h.service.send({
      userId: UID,
      sessionId: SID,
      body: body('auto'),
      directory: DIR,
      agentId: 'auto',
      correlationId: 'cid-1',
    });

    assert.equal(receipt.type, 'user');
    assert.deepEqual(
      h.appended.map((row) => row.role),
      ['user', 'tool', 'assistant'],
    );
    assert.equal(h.appended[1]?.text, 'file content');
    assert.equal(h.appended[1]?.kind, 'tool');
    assert.equal(h.appended[1]?.name, 'read');
    assert.equal(h.appended[2]?.text, 'готово');
    assert.equal(h.appended[1]?.parentId, receipt.id);
    assert.equal(h.appended[2]?.parentId, h.appended[1]?.id);
    assert.equal(h.readCalls(), 1);

    const types = h.buffer.list().map((frame) => frame.type);
    assert.deepEqual(types.slice(0, 3), [
      'session.execution.started',
      'session.reasoning.started',
      'session.step.started',
    ]);
    assert.ok(types.includes('session.tool.success'));
    assert.ok(types.includes('session.step.streamed'));
    assert.ok(types.indexOf('message.part.delta') < types.indexOf('session.text.ended'));
    assert.ok(types.indexOf('message.part.updated') < types.indexOf('session.text.ended'));
    assert.equal(types.filter((type) => type === 'session.execution.succeeded').length, 1);
    assert.equal(types.filter((type) => type === 'session.step.ended').length, 1);
    assert.equal(types.at(-1), 'session.idle');
  });

  it('ask: a mutating tool is refused, the handler never runs (tool.failed frame)', async () => {
    const h = harness(
      fakeStep([
        {
          text: '',
          calls: [{ id: 'c1', name: 'write', arguments: '{}' }],
          finishReason: 'tool-calls',
        },
        FINAL_STEP,
      ]),
    );
    await h.service.send({
      userId: UID,
      sessionId: SID,
      body: body('ask'),
      directory: DIR,
      agentId: 'auto',
      correlationId: 'cid-ask',
    });

    assert.equal(h.writeCalls(), 0);
    const failed = h.buffer
      .list()
      .filter((frame) => frame.type === 'session.tool.failed');
    assert.equal(failed.length, 1);
    assert.match(String(failed[0]?.data.error), /not allowed in ask mode/);
  });

  it('missing key: the staged user row is discarded and the 404 travels out', async () => {
    const missing = new NotFoundException({
      code: 'opencode_key_missing',
      message: 'No OpenCode API key configured for this user',
    });
    const h = harness(async (): Promise<LoopStep> => {
      throw missing;
    });

    await assert.rejects(
      h.service.send({
        userId: UID,
        sessionId: SID,
        body: body('auto'),
        directory: DIR,
        agentId: 'auto',
        correlationId: 'cid-nokey',
      }),
      (error: unknown) => error instanceof NotFoundException,
    );

    assert.deepEqual(
      h.appended.map((row) => row.role),
      ['user'],
    );
    assert.equal(h.discarded.length, 1);
    const types = h.buffer.list().map((frame) => frame.type);
    assert.ok(!types.includes('session.execution.failed'));
    assert.equal(h.state.isBusy(SID), false);
  });

  it('interrupt: the late answer is dropped (no assistant row, no terminal frames)', async () => {
    const h = harness(async (): Promise<LoopStep> => {
      // Interrupt lands while the model is answering: busy is cleared by the
      // interrupt route, so the late answer belongs to nobody.
      h.state.clearBusy(SID);
      return FINAL_STEP;
    });

    const receipt = await h.service.send({
      userId: UID,
      sessionId: SID,
      body: body('auto'),
      directory: DIR,
      agentId: 'auto',
      correlationId: 'cid-int',
    });

    assert.equal(receipt.type, 'user');
    assert.deepEqual(
      h.appended.map((row) => row.role),
      ['user'],
    );
    const types = h.buffer.list().map((frame) => frame.type);
    assert.ok(!types.includes('session.text.ended'));
    assert.ok(!types.includes('session.execution.succeeded'));
    assert.ok(!types.includes('session.idle'));
    assert.equal(h.state.isBusy(SID), false);
  });

  it('failure: a step throw buffers failed + idle with the fixed secret-free text', async () => {
    const h = harness(async (): Promise<LoopStep> => {
      throw new Error('boom-secret-should-never-surface');
    });

    await assert.rejects(
      h.service.send({
        userId: UID,
        sessionId: SID,
        body: body('auto'),
        directory: DIR,
        agentId: 'auto',
        correlationId: 'cid-fail',
      }),
    );

    assert.deepEqual(
      h.appended.map((row) => row.role),
      ['user'],
    );
    const frames = h.buffer.list();
    const types = frames.map((frame) => frame.type);
    assert.ok(types.includes('session.execution.failed'));
    assert.ok(types.includes('session.step.failed'));
    assert.equal(types.at(-1), 'session.idle');
    const failed = frames.filter(
      (frame) => frame.type === 'session.execution.failed' || frame.type === 'session.step.failed',
    );
    assert.equal(failed.length, 2);
    for (const frame of failed) {
      assert.equal(frame.data.message, IN_PROCESS_FAILED_MESSAGE);
      assert.equal(frame.data.code, 'in-process-failed');
      assert.ok(!String(frame.data.message).includes('boom'));
    }
    assert.equal(h.state.isBusy(SID), false);
  });

  it('failure: MaxStepsExceeded maps typed with the fixed text + code (partial stays buffered)', async () => {
    const h = harness(async (): Promise<LoopStep> => {
      throw new MaxStepsExceededError(1, {
        steps: 1,
        usage: { input: 10, output: 5 },
        partialText: '',
      });
    });

    await assert.rejects(
      h.service.send({
        userId: UID,
        sessionId: SID,
        body: body('auto'),
        directory: DIR,
        agentId: 'auto',
        correlationId: 'cid-maxsteps',
      }),
    );

    const frames = h.buffer.list();
    const types = frames.map((frame) => frame.type);
    assert.ok(types.includes('session.execution.failed'));
    assert.ok(types.includes('session.step.failed'));
    assert.equal(types.at(-1), 'session.idle');
    const failed = frames.filter(
      (frame) => frame.type === 'session.execution.failed' || frame.type === 'session.step.failed',
    );
    for (const frame of failed) {
      assert.equal(frame.data.message, IN_PROCESS_FAILED_MESSAGE);
      assert.equal(frame.data.code, 'max-steps-exceeded');
    }
    assert.equal(h.state.isBusy(SID), false);
  });
});

async function main(): Promise<void> {
  for (const item of cases) {
    await item.run();
    console.log(`ok ${item.name}`);
  }
  console.log(`done ${cases.length}`);
}

void main().catch((error) => {
  console.error(error);
  process.exit(1);
});
