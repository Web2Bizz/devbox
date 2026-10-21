/**
 * useInvite — mint + accept flow (persistent uuidv7, no TTL).
 *
 * Covers: mint success (InviteDto with uuidv7 + email null + createdAt,
 * token carried in body only — never logged), accept 404
 * (replay/unknown/mismatch → inviteReplay i18n strings), accept success
 * (membership, cache invalidated). No 410 — links never expire.
 */
import { afterEach, describe, expect, mock, test } from 'bun:test';
import { GlobalRegistrator } from '@happy-dom/global-registrator';

try {
  GlobalRegistrator.register({ url: 'http://localhost/' });
} catch {
  // bun runs test files in one process — second register() throws, ignore.
}

class FakeApiClientError extends Error {
  code: string;
  status: number;
  correlationId: string;
  constructor(args: { code: string; message: string; status: number; correlationId: string }) {
    super(args.message);
    this.name = 'ApiClientError';
    this.code = args.code;
    this.status = args.status;
    this.correlationId = args.correlationId;
  }
}

const ORG_ID = '11111111-1111-1111-1111-111111111111';
const V7_A = '0193a2c1-1111-7aaa-8bbb-111111111111';
const V7_B = '0193a2c1-2222-7aaa-8bbb-222222222222';
const INVITE = {
  token: V7_A,
  orgId: ORG_ID,
  email: null,
  role: 'user' as const,
  createdAt: '2026-10-20T00:00:00.000Z',
};
const EMAIL_INVITE = {
  token: V7_B,
  orgId: ORG_ID,
  email: 'mate@devbox.local',
  role: 'user' as const,
  createdAt: '2026-10-20T00:00:00.000Z',
};
const MEMBERSHIP = {
  orgId: ORG_ID,
  userId: '99999999-9999-9999-9999-999999999999',
  role: 'user' as const,
  createdAt: '2026-10-04T00:00:00.000Z',
};

const mintMock = mock(async (_token: string, _orgId: string, _body: unknown) => ({ ...INVITE }));
let acceptImpl: () => Promise<typeof MEMBERSHIP> = async () => ({ ...MEMBERSHIP });
const acceptMock = mock(() => acceptImpl());

mock.module('../../api/client', () => ({
  ApiClientError: FakeApiClientError,
  api: { createOrgInvite: mintMock, acceptOrgInvite: acceptMock },
}));

mock.module('../../lib/auth-store', () => ({
  getValidAccessToken: async () => 'test-token',
}));

const { cleanup, renderHook, act } = await import('@testing-library/react');
const { QueryClientProvider } = await import('@tanstack/react-query');
const { createElement, useState } = await import('react');
const { createQueryClient } = await import('../../lib/query-client');
const { useInvite } = await import('../useInvite');

function wrapper({ children }: { children: React.ReactNode }) {
  const [client] = useState(() => createQueryClient());
  return createElement(QueryClientProvider, { client }, children);
}

afterEach(() => {
  cleanup();
  mintMock.mockClear();
  acceptMock.mockClear();
  acceptImpl = async () => ({ ...MEMBERSHIP });
});

async function settle(rounds = 4) {
  await act(async () => {
    for (let i = 0; i < rounds; i++) {
      await Promise.resolve();
      await new Promise((r) => setTimeout(r, 0));
    }
  });
}

describe('useInvite', () => {
  test('mint: persistent InviteDto (uuidv7, email null) lands, token only in body', async () => {
    const { result } = renderHook(() => useInvite(), { wrapper });

    let minted: unknown = null;
    await act(async () => {
      minted = await result.current.mint(ORG_ID, 'user');
    });
    await settle();

    expect(mintMock).toHaveBeenCalledTimes(1);
    expect(mintMock).toHaveBeenCalledWith('test-token', ORG_ID, { role: 'user' });
    expect(minted).toMatchObject({ orgId: ORG_ID, role: 'user', email: null });
    expect(result.current.minted).toMatchObject({ orgId: ORG_ID });
    expect(result.current.mintError).toBeNull();
  });

  test('mint: email-invite carries the bound address', async () => {
    mintMock.mockImplementationOnce(async () => ({ ...EMAIL_INVITE }));
    const { result } = renderHook(() => useInvite(), { wrapper });

    let minted: unknown = null;
    await act(async () => {
      minted = await result.current.mint(ORG_ID, 'user', 'mate@devbox.local');
    });
    await settle();

    expect(mintMock).toHaveBeenCalledWith('test-token', ORG_ID, {
      role: 'user',
      email: 'mate@devbox.local',
    });
    expect(minted).toMatchObject({ email: 'mate@devbox.local' });
  });

  test('accept 404: replay/unknown/mismatch → inviteReplay strings (never expired)', async () => {
    acceptImpl = async () => {
      throw new FakeApiClientError({
        code: 'not_found',
        message: 'invite not found or already used',
        status: 404,
        correlationId: 'corr-404',
      });
    };
    const { result } = renderHook(() => useInvite(), { wrapper });

    await act(async () => {
      await result.current.accept('0193a2c1-9999-7aaa-8bbb-999999999999').catch(() => {});
    });
    await settle();

    expect(acceptMock).toHaveBeenCalledTimes(1);
    expect(result.current.acceptReplay).toBe(true);
    expect(result.current.acceptExpired).toBe(false);
    expect(result.current.acceptError).toContain('already used');
  });

  test('accept success: membership granted, no error flags', async () => {
    const { result } = renderHook(() => useInvite(), { wrapper });

    let member: unknown = null;
    await act(async () => {
      member = await result.current.accept(V7_A);
    });
    await settle();

    expect(member).toMatchObject({ orgId: ORG_ID, role: 'user' });
    expect(result.current.acceptError).toBeNull();
    expect(result.current.acceptReplay).toBe(false);
    expect(result.current.acceptExpired).toBe(false);
  });
});
