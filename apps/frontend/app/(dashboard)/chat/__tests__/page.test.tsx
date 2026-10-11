/**
 * /chat redirect — session = chat moved to /projects/[id]/sessions/[sessionId].
 *
 * Covers: the /chat segment is a server redirect to /projects
 * (no client chat UI left on the route). Contract test on file text:
 * importing the server page would pull `next/navigation` server-only
 * `redirect` (absent from the client stub in node_modules), so assert
 * the source instead — must call redirect('/projects'), must not be a
 * client component, must not mount useChat/ChatWindow.
 */
import { describe, expect, test } from 'bun:test';

const source = await Bun.file(
  new URL('../page.tsx', import.meta.url).pathname,
).text();

describe('/chat redirect', () => {
  test('is a server redirect to /projects', () => {
    expect(source).toContain("redirect('/projects')");
    expect(source).toContain("from 'next/navigation'");
  });

  test('carries no client chat UI', () => {
    expect(source).not.toContain("'use client'");
    expect(source).not.toContain('useChat');
    expect(source).not.toContain('ChatWindow');
    expect(source).not.toContain('ChatInput');
  });
});
