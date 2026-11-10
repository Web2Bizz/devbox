import { describe, expect, test } from 'bun:test';

import {
  createRunRequestSchema,
  runInfoListSchema,
  runInfoSchema,
  runStreamFrameSchema,
  toolViewSchema,
} from '../runs.schema';
import { sendMessageRequestSchema } from '../../sessions/sessions.schema';

const projectId = '0199c5b6-7c8f-7a1b-9d2e-1f2a3b4c5d6e';
const runId = '0199c5b6-7c8f-7a1b-9d2e-1f2a3b4c5d6f';

const validRunInfo = {
  id: runId,
  projectId,
  title: null,
  status: 'open',
  definitionSetHash: 'sha256:active-definitions',
  baseCommit: '00c3c39',
  branch: `agent/${runId}`,
  worktree: `/repos/rush-code/.worktrees/${runId}`,
  sandboxId: null,
  agentId: null,
  model: null,
  createdAt: '2026-11-05T10:00:00.000Z',
  updatedAt: '2026-11-05T10:00:00.000Z',
};

describe('sendMessageRequestSchema', () => {
  const base = { projectId, text: 'hello' };

  test('accepts mode auto|ask and omitted mode (default auto)', () => {
    expect(sendMessageRequestSchema.safeParse({ ...base, mode: 'auto' }).success).toBe(true);
    expect(sendMessageRequestSchema.safeParse({ ...base, mode: 'ask' }).success).toBe(true);
    expect(sendMessageRequestSchema.safeParse(base).success).toBe(true);
  });

  test('rejects an unknown mode', () => {
    expect(sendMessageRequestSchema.safeParse({ ...base, mode: 'hack' }).success).toBe(false);
  });
});

describe('createRunRequestSchema', () => {
  test('accepts a project-scoped run create', () => {
    const parsed = createRunRequestSchema.safeParse({
      projectId,
      title: 'Add runs domain',
      agentId: 'ask',
      definitionSetHash: 'sha256:active-definitions',
    });
    expect(parsed.success).toBe(true);
  });

  test('rejects a body without projectId', () => {
    expect(createRunRequestSchema.safeParse({ title: 'orphan run' }).success).toBe(false);
  });

  test('rejects a non-uuid projectId', () => {
    expect(createRunRequestSchema.safeParse({ projectId: 'project-1' }).success).toBe(false);
  });

  test('rejects a title longer than 200 characters', () => {
    expect(
      createRunRequestSchema.safeParse({ projectId, title: 'a'.repeat(201) }).success,
    ).toBe(false);
  });
});

describe('runInfoSchema', () => {
  test('accepts explicit null title/model/agentId/sandboxId', () => {
    const parsed = runInfoSchema.safeParse(validRunInfo);
    expect(parsed.success).toBe(true);
  });

  test('accepts populated model/agentId/sandboxId', () => {
    const parsed = runInfoSchema.safeParse({
      ...validRunInfo,
      title: 'Run 1',
      model: { id: 'claude-sonnet', providerID: 'anthropic' },
      agentId: 'ask',
      sandboxId: 'sandbox-1',
    });
    expect(parsed.success).toBe(true);
  });

  test('rejects a row without worktree', () => {
    expect(runInfoSchema.safeParse({ ...validRunInfo, worktree: undefined }).success).toBe(false);
  });

  test('rejects a row without baseCommit', () => {
    expect(runInfoSchema.safeParse({ ...validRunInfo, baseCommit: undefined }).success).toBe(false);
  });

  test('rejects a non-ISO createdAt', () => {
    expect(runInfoSchema.safeParse({ ...validRunInfo, createdAt: '05.11.2026' }).success).toBe(
      false,
    );
  });
});

describe('runStreamFrameSchema', () => {
  test('accepts all four prototype frame types', () => {
    const types = [
      'run.started',
      'run.step.started',
      'run.step.committed',
      'run.step.failed',
    ];
    for (const type of types) {
      expect(runStreamFrameSchema.safeParse({ id: '1', type, data: {} }).success).toBe(true);
    }
  });

  test('rejects an unknown frame type', () => {
    expect(runStreamFrameSchema.safeParse({ id: '1', type: 'run.finished', data: {} }).success).toBe(
      false,
    );
  });

  test('rejects an empty id', () => {
    expect(runStreamFrameSchema.safeParse({ id: '', type: 'run.started', data: {} }).success).toBe(
      false,
    );
  });
});

describe('toolViewSchema', () => {
  test('accepts prefixed native/mcp/skill tool ids', () => {
    for (const id of ['native:git.recon', 'mcp:github/search', 'skill:code-review']) {
      const parsed = toolViewSchema.safeParse({
        id,
        title: 'Tool',
        description: 'Model-facing projection',
        inputSchema: {},
      });
      expect(parsed.success).toBe(true);
    }
  });

  test('rejects an id without origin prefix', () => {
    expect(
      toolViewSchema.safeParse({
        id: 'git.recon',
        title: 'Tool',
        description: 'Model-facing projection',
        inputSchema: {},
      }).success,
    ).toBe(false);
  });

  test('rejects an unknown origin prefix', () => {
    expect(
      toolViewSchema.safeParse({
        id: 'foo:bar',
        title: 'Tool',
        description: 'Model-facing projection',
        inputSchema: {},
      }).success,
    ).toBe(false);
  });
});

describe('runInfoListSchema', () => {
  test('accepts a run array', () => {
    expect(runInfoListSchema.safeParse([validRunInfo]).success).toBe(true);
  });

  test('rejects a non-array payload', () => {
    expect(runInfoListSchema.safeParse(validRunInfo).success).toBe(false);
  });
});
