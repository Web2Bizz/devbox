'use client';

import { useCallback, useMemo } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { ApiClientError, api } from '../api/client';
import { formatApiError } from '../lib/format-error';
import { getValidAccessToken } from '../lib/auth-store';
import type { OrganizationInvite as InviteDto, OrganizationMember as MemberDto, OrgRole } from '@devbox/contracts';
import { useI18n } from '../i18n';
import { ORGANIZATIONS_QUERY_KEY } from './useOrganizations';
import { orgMembersQueryKey } from './useOrgMembers';

export type UseInviteResult = {
  minted: InviteDto | null;
  minting: boolean;
  mintError: string | null;
  /**
   * Mint a persistent single-use invite (uuidv7, no TTL).
   * `email` binds the invite to one address; absent = open link-invite.
   * The token is returned ONCE and never logged.
   */
  mint: (orgId: string, role?: OrgRole, email?: string) => Promise<InviteDto>;
  accepting: boolean;
  acceptError: string | null;
  /**
   * @deprecated Links never expire — always false (kept one release for
   * callers; accept maps only 404 → replay).
   */
  acceptExpired: boolean;
  acceptReplay: boolean;
  /** Accept by uuidv7 token. 404 (replay/unknown/email mismatch) maps to i18n strings. */
  accept: (token: string) => Promise<MemberDto>;
  reset: () => void;
};

/**
 * Invite flow hook.
 * - mint: POST /organizations/:id/invites {role?, email?} (maintainer only)
 * - accept: POST /organizations/invites/accept {token: uuidv7}
 *   (replay/unknown/mismatch → 404 inviteReplay strings; no 410 — never expires)
 * - Token material never reaches logs — bodies only, no console.* anywhere.
 */
export function useInvite(): UseInviteResult {
  const { t } = useI18n();
  const queryClient = useQueryClient();

  const mintMutation = useMutation({
    mutationFn: async (input: { orgId: string; role?: OrgRole; email?: string }): Promise<InviteDto> => {
      const token = await getValidAccessToken();
      if (!token) throw new Error(t.errors.sessionExpired);
      const body: { role?: OrgRole; email?: string } = {};
      if (input.role) body.role = input.role;
      if (input.email) body.email = input.email;
      return api.createOrgInvite(token, input.orgId, body);
    },
  });

  const mint = useCallback(
    (orgId: string, role?: OrgRole, email?: string) => mintMutation.mutateAsync({ orgId, role, email }),
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
