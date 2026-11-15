/**
 * runs-client — SSE frame parser tests (api/runs-client.ts `runFrameStream`).
 *
 * The parser is deliberately pure: it takes an already-open Response, so no
 * auth/fetch is involved here (the domain auth path is covered by
 * sessions-client tests + `withAuth`). The point is the DOMAIN BOUNDARY of
 * GET /api/v1/runs/{id}/events: `data:` payloads parse to
 * @rush-code/contracts RunStreamFrame rows, heartbeat/comment lines are
 * transport framing (skipped, never a frame), multi-line `data:` chunks join
 * into one frame, and a malformed frame FAILS LOUD (throws out of the
 * generator — the hook treats it as a stream break and redials).
 */
import { describe, expect, test } from 'bun:test';
import { GlobalRegistrator } from '@happy-dom/global-registrator';
import type { RunStreamFrame } from '@rush-code/contracts';
import { runFrameStream } from '../runs-client';

try {
  GlobalRegistrator.register({ url: 'http://localhost/' });
} catch {
  // bun runs test files in one process — second register() throws, ignore.
}

/** Open SSE answer over a stream that yields the given raw chunks. */
function sseResponse(chunks: string[]): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
  return new Response(stream, {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  });
}

async function collectFrames(res: Response): Promise<RunStreamFrame[]> {
  const frames: RunStreamFrame[] = [];
  for await (const frame of runFrameStream(res)) frames.push(frame);
  return frames;
}

describe('runFrameStream (GET /api/v1/runs/{id}/events framing)', () => {
  test('data: frames parse to domain rows; heartbeat skipped; multi-line JSON joins', async () => {
    const chunks = [
      ':\n\n',
      'data: {"id":"1","type":"run.st',
      'arted","data":{"step":"boot"},"run":"run-1"}\n\n',
      'data: {"id":"2","type":"run.step.committed",\n',
      'data: "data":{"step":"s1"},"run":"run-1"}\n\n',
    ];
    const frames = await collectFrames(sseResponse(chunks));

    // Heartbeat is transport framing, not a frame.
    expect(frames.length).toBe(2);
    expect(frames[0]?.id).toBe('1');
    expect(frames[0]?.type).toBe('run.started');
    expect(frames[0]?.run).toBe('run-1');
    expect(frames[1]?.id).toBe('2');
    expect(frames[1]?.type).toBe('run.step.committed');
    // Multi-line `data:` lines join with '\n' into ONE payload.
    expect(frames[1]?.data).toEqual({ step: 's1' });
    expect(frames[1]?.run).toBe('run-1');
  });

  test('malformed frame fails loud (never a silent skip)', async () => {
    await expect(collectFrames(sseResponse(['data: {"id":"1"}\n\n']))).rejects.toThrow();
  });

  test('empty stream yields no frames', async () => {
    const frames = await collectFrames(sseResponse([]));
    expect(frames).toEqual([]);
  });
});
