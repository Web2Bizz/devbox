'use client';

import { useCallback, useMemo } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { ApiClientError, api } from '../api/client';
import { formatApiError } from '../lib/format-error';
import { getValidAccessToken } from '../lib/auth-store';
import type { InviteDto, MemberDto, OrgRole } from '../api/types';
import { useI18n } from '../i18n';
import { ORGANIZATIONS_QUERY_KEY } from './useOrganizations';
import { orgMembersQueryKey } from './useOrgMembers';

export interface UseInviteResult {
  minted: InviteDto | null;
  minting: boolean;
  mintError: string | null;
  /** Mint a single-use invite. The token is returned ONCE and never logged. */
  mint: (orgId: string, role?: OrgRole) => Promise<InviteDto>;
  accepting: boolean;
  acceptError: string | null;
  acceptExpired: boolean;
  acceptReplay: boolean;
  /** Accept by token. 404 (replay/unknown) and 410 (expired) map to i18n strings. */
  accept: (token: string) => Promise<MemberDto>;
  reset: () => void;
}

/**
 * Invite flow hook.
 * - mint: POST /organizations/:id/invites (maintainer only)
 * - accept: POST /organizations/invites/accept {token}
 *   (replay → 404 inviteReplay strings, expired → 410 inviteExpired strings)
 * - Token material never reaches logs — bodies only, no console.* anywhere.
 */
export function useInvite(): UseInviteResult {
  const { t } = useI18n();
  const queryClient = useQueryClient();

  const mintMutation = useMutation({
    mutationFn: async (input: { orgId: string; role?: OrgRole }): Promise<InviteDto> => {
      const token = await getValidAccessToken();
      if (!token) throw new Error(t.errors.sessionExpired);
      return api.createOrgInvite(token, input.orgId, input.role ? { role: input.role } : {});
    },
  });

  const mint = useCallback(
    (orgId: string, role?: OrgRole) => mintMutation.mutateAsync({ orgId, role }),
    [mintMutation],
  );

  const mintError = useMemo(() => {
    if (!mintMutation.error) return null;
    const formatted = formatApiError(mintMutation.error);
    return formatted === 'Unexpected error' ? t.errors.unexpected : formatted;
  }, [mintMutation.error, t]);

  const acceptMutation = useMutation({
    mutationFn: async (inviteToken: string): Promise<MemberDto> => {
      const token = await getValidAccessToken();
      if (!token) throw new Error(t.errors.sessionExpired);
      return api.acceptOrgInvite(token, { token: inviteToken });
    },
    onSuccess: (member) => {
      void queryClient.invalidateQueries({ queryKey: ORGANIZATIONS_QUERY_KEY });
      void queryClient.invalidateQueries({ queryKey: orgMembersQueryKey(member.orgId) });
    },
  });

  const accept = useCallback(
    (inviteToken: string) => acceptMutation.mutateAsync(inviteToken),
    [acceptMutation],
  );

  const { acceptError, acceptExpired, acceptReplay } = useMemo(() => {
    const err = acceptMutation.error;
    if (!err) return { acceptError: null as string | null, acceptExpired: false, acceptReplay: false };
    if (err instanceof ApiClientError && err.status === 410) {
      return { acceptError: t.orgs.inviteExpiredDesc, acceptExpired: true, acceptReplay: false };
    }
    if (err instanceof ApiClientError && err.status === 404) {
      return { acceptError: t.orgs.inviteReplayDesc, acceptExpired: false, acceptReplay: true };
    }
    const formatted = formatApiError(err);
    return {
      acceptError: formatted === 'Unexpected error' ? t.errors.unexpected : formatted,
      acceptExpired: false,
      acceptReplay: false,
    };
  }, [acceptMutation.error, t]);

  const reset = useCallback(() => {
    mintMutation.reset();
    acceptMutation.reset();
  }, [mintMutation, acceptMutation]);

  return {
    minted: mintMutation.data ?? null,
    minting: mintMutation.isPending,
    mintError,
    mint,
    accepting: acceptMutation.isPending,
    acceptError,
    acceptExpired,
    acceptReplay,
    accept,
    reset,
  };
}
