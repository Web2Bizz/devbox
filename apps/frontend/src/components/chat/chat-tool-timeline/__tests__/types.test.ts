import { describe, expect, test } from 'bun:test';
import {
  getToolCallFixture,
  toLiveReasoningCallProps,
  toLiveToolCallProps,
  toToolCallProps,
  toToolCallStatus,
  toToolCallStatusFromEvent,
  type ChatToolEvent,
} from '../types';
import { en } from '../../../../i18n/dictionaries/en';

function toolEvent(partial: Partial<ChatToolEvent> & { label: string }): ChatToolEvent {
  return {
    id: 't1',
    at: 1700000000000,
    kind: 'tool',
    ...partial,
  };
}

describe('toToolCallStatus', () => {
  test('pending: called/started/empty map to pending (kit shows queued)', () => {
    expect(toToolCallStatus('called')).toBe('pending');
    expect(toToolCallStatus('started')).toBe('pending');
    expect(toToolCallStatus(undefined)).toBe('pending');
    expect(toToolCallStatus('')).toBe('pending');
  });

  test('running: progress/thinking/free-text snippets map to running (kit shows loading)', () => {
    expect(toToolCallStatus('progress')).toBe('running');
    expect(toToolCallStatus('thinking')).toBe('running');
    expect(toToolCallStatus('step one')).toBe('running');
  });

  test('success: done maps to success', () => {
    expect(toToolCallStatus('done')).toBe('success');
  });

  test('error: failed/fail/error snippets map to error', () => {
    expect(toToolCallStatus('failed')).toBe('error');
    expect(toToolCallStatus('boom')).toBe('running');
    expect(toToolCallStatus('step failed')).toBe('error');
    expect(toToolCallStatus('Error: timeout')).toBe('error');
  });

  test('warning: warn/review snippets map to warning', () => {
    expect(toToolCallStatus('review')).toBe('warning');
    expect(toToolCallStatus('warn: slow')).toBe('warning');
    expect(toToolCallStatus('review pending')).toBe('warning');
  });
});

describe('toToolCallStatusFromEvent', () => {
  test('delegates to detail mapping', () => {
    expect(toToolCallStatusFromEvent(toolEvent({ label: 'bash', detail: 'done' }))).toBe('success');
    expect(toToolCallStatusFromEvent(toolEvent({ label: 'bash', detail: 'failed' }))).toBe('error');
  });
});

describe('getToolCallFixture', () => {
  test('Image2 demo tools carry args/result/summary', () => {
    expect(getToolCallFixture('search_web').summary).toBe('3 results');
    expect(getToolCallFixture('search_web').args).toContain('query');
    expect(getToolCallFixture('search_web').result).toContain('3 results');
    expect(getToolCallFixture('read_file').summary).toBe('src/app/page.tsx');
    expect(getToolCallFixture('deploy_preview').summary).toBe('review');
    expect(getToolCallFixture('run_tests').summary).toBe('failed');
  });

  test('unknown labels have no fixture payloads', () => {
    expect(getToolCallFixture('bash')).toEqual({});
  });
});

describe('toToolCallProps', () => {
  test('tool: name as-is, status from detail, summary via t.chat', () => {
    const card = toToolCallProps(toolEvent({ label: 'bash', detail: 'called' }), en);
    expect(card.name).toBe('bash');
    expect(card.status).toBe('pending');
    expect(card.summary).toBe(en.chat.toolCalled);
  });

  test('reasoning: human label via t.chat, never raw reasoning', () => {
    const card = toToolCallProps(
      { id: 't2', at: 1700000000000, kind: 'reasoning', label: 'reasoning', detail: 'started' },
      en,
    );
    expect(card.name).toBe(en.chat.reasoningLabel);
    expect(card.status).toBe('pending');
  });

  test('free-text detail becomes args, phase keywords stay empty', () => {
    const snippet = toToolCallProps(toolEvent({ label: 'bash', detail: 'custom payload' }));
    expect(snippet.args).toBe('custom payload');
    const phased = toToolCallProps(toolEvent({ label: 'bash', detail: 'called' }));
    expect(phased.args).toBeUndefined();
  });
});

describe('live cards', () => {
  test('live tool is always running', () => {
    expect(toLiveToolCallProps('bash')).toMatchObject({ name: 'bash', status: 'running' });
  });

  test('live reasoning truncates to 500 chars', () => {
    const long = 'x'.repeat(600);
    const card = toLiveReasoningCallProps(long, 'Thinking');
    expect(card.status).toBe('running');
    expect(card.summary?.length).toBe(500);
  });
});
