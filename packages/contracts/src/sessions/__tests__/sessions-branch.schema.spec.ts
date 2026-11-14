import { describe, expect, test } from 'bun:test';

import {
  revertMessagesRequestSchema,
  revertMessagesResultSchema,
  sendMessageRequestSchema,
  sessionExecutionFrameSchema,
  sessionMessageVariantListSchema,
  sessionMessageVariantSchema,
  sessionStepFrameSchema,
  sessionThreadViewSchema,
} from '../sessions.schema';

const projectId = '0199c5b6-7c8f-7a1b-9d2e-1f2a3b4c5d6e';

describe('session branch schemas', () => {
  test('sendMessage accepts an explicit parentId and omitted parentId', () => {
    const base = { projectId, text: 'hello' };
    expect(sendMessageRequestSchema.safeParse(base).success).toBe(true);
    expect(
      sendMessageRequestSchema.safeParse({ ...base, parentId: 'm-root' }).success,
    ).toBe(true);
    expect(sendMessageRequestSchema.safeParse({ ...base, parentId: '' }).success).toBe(
      false,
    );
  });

  test('sessionMessageVariant requires childId/createdAt/preview', () => {
    const row = {
      childId: 'm-b',
      createdAt: '2026-01-01T00:00:01.000Z',
      preview: 'second answer',
    };
    expect(sessionMessageVariantSchema.safeParse(row).success).toBe(true);
    expect(sessionMessageVariantListSchema.safeParse([row]).success).toBe(true);
    expect(
      sessionMessageVariantSchema.safeParse({ ...row, childId: '' }).success,
    ).toBe(false);
  });

  test('sessionThreadView carries chain + variants + activeLeaf', () => {
    const view = {
      chain: [
        {
          id: 'm-root',
          type: 'user',
          createdAt: '2026-01-01T00:00:00.000Z',
          text: 'hi',
          parentId: null,
        },
      ],
      variants: [],
      activeLeaf: 'm-root',
    };
    expect(sessionThreadViewSchema.safeParse(view).success).toBe(true);
  });

  test('revertMessages request/result round-trip', () => {
    expect(
      revertMessagesRequestSchema.safeParse({ projectId, messageID: 'm-b' }).success,
    ).toBe(true);
    expect(revertMessagesResultSchema.safeParse({ activeLeaf: 'm-root' }).success).toBe(
      true,
    );
    expect(revertMessagesResultSchema.safeParse({ activeLeaf: null }).success).toBe(true);
  });

  test('failed frames carry message + code (secret-free terminal)', () => {
    const execution = {
      id: 'f-1',
      type: 'session.execution.failed',
      data: {
        sessionID: 'ses-1',
        message: 'не удалось выполнить ход, повторите позже',
        code: 'in-process-failed',
      },
    };
    const step = {
      id: 'f-2',
      type: 'session.step.failed',
      data: { sessionID: 'ses-1', message: 'не удалось выполнить ход, повторите позже', code: 'max-steps-exceeded' },
    };
    expect(sessionExecutionFrameSchema.safeParse(execution).success).toBe(true);
    expect(sessionStepFrameSchema.safeParse(step).success).toBe(true);
    // code stays optional for backward compat (old buffers without code).
    expect(
      sessionExecutionFrameSchema.safeParse({
        id: 'f-3',
        type: 'session.execution.failed',
        data: { sessionID: 'ses-1' },
      }).success,
    ).toBe(true);
  });
});
