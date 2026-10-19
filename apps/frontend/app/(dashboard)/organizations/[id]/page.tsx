'use client';

import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { useCallback, useMemo, useState } from 'react';
import {
  Alert,
  AlertDescription,
  AlertTitle,
  Badge,
  Button,
  Input,
  Separator,
} from '@web2bizz/ui/components';
import {
  EmptyState,
  ErrorState,
  ProjectDetailSkeleton,
} from '@/components/states';
import { useOrganization } from '@/hooks/useOrganization';
import { useOrgMembers } from '@/hooks/useOrgMembers';
import { useInvite } from '@/hooks/useInvite';
import { useProfile } from '@/hooks/useProfile';
import { ApiClientError, api } from '@/api/client';
import { getValidAccessToken } from '@/lib/auth-store';
import type { OrgRole } from '@/api/types';
import { useI18n } from '@/i18n';

function shortId(id: string): string {
  return id.length > 8 ? `${id.slice(0, 8)}…` : id;
}

/**
 * Route: /organizations/[id] — flat Content (§6: no nested Cards, Alert only
 * for errors; §3 radius var(); §3.1 no gradients/shadows/transforms).
 * Sections: overview, members (role change/remove), invites (mint + copy,
 * maintainer only), projects (link/unlink). 400/409 map to friendly strings.
 * Invite tokens travel memory only — never logged.
 */
export default function OrganizationDetailPage() {
  const { t } = useI18n();
  const params = useParams();
  const router = useRouter();
  const raw = params?.id;
  const id = Array.isArray(raw) ? raw[0] : (raw as string | undefined);

  const { organization, loading, error, notFound, forbidden, reload, remove, removing } =
    useOrganization(id);
  const {
    members,
    loading: membersLoading,
    error: membersError,
    reload: reloadMembers,
    changeRole,
    removeMember,
    mutating: membersMutating,
  } = useOrgMembers(id);
  const { minted, minting, mintError, mint } = useInvite();
  const { profile } = useProfile();

  const [memberActionError, setMemberActionError] = useState<string | null>(null);
  const [linkProjectId, setLinkProjectId] = useState('');
  const [linkBusy, setLinkBusy] = useState(false);
  const [linkMessage, setLinkMessage] = useState<string | null>(null);
  const [linkIsError, setLinkIsError] = useState(false);
  const [copied, setCopied] = useState(false);

  const isMaintainer = useMemo(() => {
    if (!profile || members.length === 0) return false;
    const own = members.find((m) => m.userId === profile.id);
    return own?.role === 'maintainer';
  }, [profile, members]);

  const inviteLink = useMemo(() => {
    if (!minted) return null;
    const origin = typeof window !== 'undefined' ? window.location.origin : '';
    return `${origin}/organizations/invites/accept?token=${encodeURIComponent(minted.token)}`;
  }, [minted]);

  const mapMemberError = useCallback(
    (e: unknown): string => {
      if (e instanceof ApiClientError && e.status === 400) return t.orgs.lastMaintainer;
      if (e instanceof ApiClientError && e.status === 409) return t.orgs.errors.conflict;
      if (e instanceof ApiClientError && e.status === 403) return t.orgs.errors.forbidden;
      if (e instanceof ApiClientError && e.status === 404) return t.orgs.errors.notFound;
      return t.errors.unexpected;
    },
    [t],
  );

  const handleRoleToggle = useCallback(
    async (userId: string, current: OrgRole) => {
      setMemberActionError(null);
      const next: OrgRole = current === 'maintainer' ? 'user' : 'maintainer';
      try {
        await changeRole(userId, next);
      } catch (e) {
        setMemberActionError(mapMemberError(e));
      }
    },
    [changeRole, mapMemberError],
  );

  const handleRemoveMember = useCallback(
    async (userId: string) => {
      setMemberActionError(null);
      try {
        await removeMember(userId);
      } catch (e) {
        setMemberActionError(mapMemberError(e));
      }
    },
    [removeMember, mapMemberError],
  );

  const handleMint = useCallback(async () => {
    if (!id) return;
    try {
      await mint(id, 'user');
      setCopied(false);
    } catch {
      // surfaced via mintError from the hook
    }
  }, [id, mint]);

  const handleCopy = useCallback(async () => {
    if (!inviteLink) return;
    try {
      await navigator.clipboard.writeText(inviteLink);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      setCopied(false);
    }
  }, [inviteLink]);

  const handleLink = useCallback(async () => {
    if (!id || !linkProjectId.trim()) return;
    setLinkBusy(true);
    setLinkMessage(null);
    setLinkIsError(false);
    try {
      const token = await getValidAccessToken();
      if (!token) throw new Error(t.errors.sessionExpired);
      await api.linkOrgProject(token, id, linkProjectId.trim());
      setLinkProjectId('');
      setLinkMessage(t.orgs.linkProject);
      setLinkIsError(false);
    } catch (e) {
      if (e instanceof ApiClientError && e.status === 409) {
        setLinkMessage(t.orgs.alreadyLinked);
      } else if (e instanceof ApiClientError && e.status === 403) {
        setLinkMessage(t.orgs.errors.forbidden);
      } else if (e instanceof ApiClientError && e.status === 404) {
        setLinkMessage(t.orgs.errors.notFound);
      } else {
        setLinkMessage(t.errors.unexpected);
      }
      setLinkIsError(true);
    } finally {
      setLinkBusy(false);
    }
  }, [id, linkProjectId, t]);

  const handleUnlink = useCallback(async () => {
    if (!id || !linkProjectId.trim()) return;
    setLinkBusy(true);
    setLinkMessage(null);
    setLinkIsError(false);
    try {
      const token = await getValidAccessToken();
      if (!token) throw new Error(t.errors.sessionExpired);
      await api.unlinkOrgProject(token, id, linkProjectId.trim());
      setLinkProjectId('');
      setLinkMessage(t.orgs.unlinkProject);
      setLinkIsError(false);
    } catch (e) {
      if (e instanceof ApiClientError && e.status === 403) {
        setLinkMessage(t.orgs.errors.forbidden);
      } else if (e instanceof ApiClientError && e.status === 404) {
        setLinkMessage(t.orgs.errors.notFound);
      } else {
        setLinkMessage(t.errors.unexpected);
      }
      setLinkIsError(true);
    } finally {
      setLinkBusy(false);
    }
  }, [id, linkProjectId, t]);

  const handleDelete = useCallback(async () => {
    try {
      await remove();
      router.push('/organizations');
    } catch {
      // surfaced via removeError toast below (read from hook through error state)
    }
  }, [remove, router]);

  const crumbs = [
    { label: t.nav.organizations, href: '/organizations' as const },
    ...(organization && !loading ? [{ label: organization.name, href: undefined }] : []),
  ];

  return (
    <div>
      <nav
        aria-label={t.nav.sections}
        className="text-muted-foreground mb-3 flex min-w-0 flex-wrap items-center gap-1 text-sm"
      >
        {crumbs.map((crumb, i) => {
          const isLast = i === crumbs.length - 1;
          return (
            <span key={`${crumb.label}-${i}`} className="flex items-center gap-1">
              {i > 0 && (
                <span aria-hidden="true" className="text-muted-foreground">
                  /
                </span>
              )}
              {crumb.href && !isLast ? (
                <Link href={crumb.href} className="hover:underline">
                  {crumb.label}
                </Link>
              ) : (
                <span aria-current={isLast ? 'page' : undefined}>{crumb.label}</span>
              )}
            </span>
          );
        })}
      </nav>

      {loading && <ProjectDetailSkeleton />}

      {!loading && notFound && (
        <div>
          <div className="mb-4">
            <Link
              href="/organizations"
              className="text-muted-foreground text-sm hover:underline focus-visible:outline-2 focus-visible:outline-offset-2"
            >
              ← {t.orgs.back}
            </Link>
          </div>
          <EmptyState
            title={t.orgs.notFoundTitle}
            description={error ?? t.orgs.notFoundDesc}
            actionLabel={t.orgs.back}
            onAction={() => router.push('/organizations')}
          />
        </div>
      )}

      {!loading && !notFound && (forbidden || (error && !organization)) && (
        <div>
          <div className="mb-4">
            <Link
              href="/organizations"
              className="text-muted-foreground text-sm hover:underline focus-visible:outline-2 focus-visible:outline-offset-2"
            >
              ← {t.orgs.back}
            </Link>
          </div>
          <ErrorState message={forbidden ? t.orgs.forbiddenDesc : (error ?? t.errors.unexpected)} />
        </div>
      )}

      {!loading && !error && !notFound && !forbidden && organization && (
        <div className="grid gap-6">
          <section aria-labelledby="org-overview" className="grid gap-2">
            <h1 id="org-overview" className="text-2xl font-semibold">
              {organization.name}
            </h1>
            <h2 className="text-lg font-semibold">{t.orgs.overviewTitle}</h2>
            <p className="text-muted-foreground text-sm">{t.orgs.detailSubtitle}</p>
            {organization.description && <p className="text-sm">{organization.description}</p>}
            <p className="text-muted-foreground text-xs">
              {t.projects.updatedPrefix} {new Date(organization.updatedAt).toLocaleDateString()}
            </p>
            {isMaintainer && (
              <div>
                <Button variant="outline" size="sm" onClick={handleDelete} disabled={removing}>
                  {t.common.delete}
                </Button>
              </div>
            )}
          </section>

          <Separator />

          <section aria-labelledby="org-members" className="grid gap-2">
            <h2 id="org-members" className="text-lg font-semibold">
              {t.orgs.membersTitle}
            </h2>
            <p className="text-muted-foreground text-sm">{t.orgs.membersDesc}</p>
            {memberActionError && (
              <Alert variant="destructive">
                <AlertTitle>{t.errors.somethingWentWrong}</AlertTitle>
                <AlertDescription>{memberActionError}</AlertDescription>
              </Alert>
            )}
            {membersError && <ErrorState message={membersError} onRetry={reloadMembers} />}
            {membersLoading && (
              <p className="text-muted-foreground text-sm">{t.common.loading}</p>
            )}
            {!membersLoading && !membersError && members.length === 0 && (
              <p className="text-muted-foreground text-sm">{t.orgs.emptyDesc}</p>
            )}
            {!membersLoading && members.length > 0 && (
              <ul className="grid gap-2">
                {members.map((m) => (
                  <li
                    key={m.userId}
                    className="flex flex-wrap items-center gap-2 rounded-[var(--radius-sm)] py-2"
                  >
                    <code className="mono text-muted-foreground text-xs">
                      {shortId(m.userId)}
                    </code>
                    <Badge color={m.role === 'maintainer' ? 'warning' : 'muted'} variant="soft">
                      {m.role === 'maintainer' ? t.orgs.roles.maintainer : t.orgs.roles.user}
                    </Badge>
                    {isMaintainer && (
                      <span className="flex flex-wrap items-center gap-2">
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => handleRoleToggle(m.userId, m.role)}
                          disabled={membersMutating}
                        >
                          {t.orgs.changeRole}
                        </Button>
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => handleRemoveMember(m.userId)}
                          disabled={membersMutating}
                        >
                          {t.orgs.removeMember}
                        </Button>
                      </span>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </section>

          {isMaintainer && (
            <>
              <Separator />
              <section aria-labelledby="org-invites" className="grid gap-2">
                <h2 id="org-invites" className="text-lg font-semibold">
                  {t.orgs.inviteTitle}
                </h2>
                <p className="text-muted-foreground text-sm">{t.orgs.inviteDesc}</p>
                {mintError && (
                  <Alert variant="destructive">
                    <AlertTitle>{t.errors.somethingWentWrong}</AlertTitle>
                    <AlertDescription>{mintError}</AlertDescription>
                  </Alert>
                )}
                <div className="flex flex-wrap items-center gap-2">
                  <Button variant="primaryBrand" size="sm" onClick={handleMint} disabled={minting}>
                    {minting ? t.orgs.minting : t.orgs.mintInvite}
                  </Button>
                  {inviteLink && (
                    <Button variant="outline" size="sm" onClick={handleCopy}>
                      {copied ? t.common.copied : t.orgs.copyLink}
                    </Button>
                  )}
                </div>
                {inviteLink && (
                  <code className="mono text-muted-foreground text-xs break-all">
                    {inviteLink}
                  </code>
                )}
              </section>
            </>
          )}

          <Separator />

          <section aria-labelledby="org-projects" className="grid gap-2">
            <h2 id="org-projects" className="text-lg font-semibold">
              {t.orgs.projectsTitle}
            </h2>
            <p className="text-muted-foreground text-sm">{t.orgs.projectsDesc}</p>
            {linkMessage && linkIsError && (
              <Alert variant="destructive">
                <AlertTitle>{t.errors.somethingWentWrong}</AlertTitle>
                <AlertDescription>{linkMessage}</AlertDescription>
              </Alert>
            )}
            {linkMessage && !linkIsError && (
              <p className="text-muted-foreground text-sm">{linkMessage}</p>
            )}
            {isMaintainer ? (
              <div className="flex flex-wrap items-center gap-2">
                <Input
                  value={linkProjectId}
                  onChange={(e) => setLinkProjectId(e.target.value)}
                  placeholder={t.orgs.linkPlaceholder}
                  disabled={linkBusy}
                  className="max-w-xs"
                />
                <Button
                  variant="outline"
                  size="sm"
                  onClick={handleLink}
                  disabled={linkBusy || !linkProjectId.trim()}
                >
                  {t.orgs.linkProject}
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={handleUnlink}
                  disabled={linkBusy || !linkProjectId.trim()}
                >
                  {t.orgs.unlinkProject}
                </Button>
              </div>
            ) : (
              <p className="text-muted-foreground text-sm">{t.orgs.forbiddenDesc}</p>
            )}
          </section>

          <div>
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                reload();
                reloadMembers();
              }}
            >
              {t.common.refresh}
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
