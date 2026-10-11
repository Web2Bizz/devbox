'use client';

import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useEffect, useRef } from 'react';
import { ErrorState, ProjectDetailSkeleton } from '../../../../../src/components/states';
import { useInvite } from '../../../../../src/hooks/useInvite';
import { useI18n } from '../../../../../src/i18n';

/**
 * Route: /organizations/invites/accept?token=… — single-use invite accept.
 * Success → redirect into the org; replay (404) / expired (410) → i18n strings.
 * The token travels memory only (search param → mutation body) — never logged.
 */
function AcceptInviteInner() {
  const { t } = useI18n();
  const router = useRouter();
  const searchParams = useSearchParams();
  const token = searchParams.get('token');
  const { accepting, acceptError, acceptExpired, acceptReplay, accept } = useInvite();
  const attempted = useRef<string | null>(null);

  useEffect(() => {
    if (!token || attempted.current === token) return;
    attempted.current = token;
    (async () => {
      try {
        const member = await accept(token);
        router.replace(`/organizations/${member.orgId}`);
      } catch {
        // surfaced via acceptError/acceptExpired/acceptReplay from the hook
      }
    })();
  }, [token, accept, router]);

  if (!token) {
    return (
      <div className="grid gap-3">
        <ErrorState message={t.orgs.inviteReplayDesc} />
        <div>
          <Link
            href="/organizations"
            className="text-sm underline-offset-4 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2"
          >
            ← {t.orgs.back}
          </Link>
        </div>
      </div>
    );
  }

  if (accepting || (!acceptError && attempted.current === token)) {
    return (
      <div className="grid gap-3">
        <h1 className="text-2xl font-semibold">
          {t.orgs.inviteAccepted} <span className="text-gradient-brand">…</span>
        </h1>
        <ProjectDetailSkeleton />
      </div>
    );
  }

  if (acceptError) {
    const title = acceptExpired
      ? t.orgs.inviteExpired
      : acceptReplay
        ? t.orgs.inviteReplay
        : t.errors.somethingWentWrong;
    return (
      <div className="grid gap-3">
        <h1 className="text-2xl font-semibold">{title}</h1>
        <ErrorState title={title} message={acceptError} />
        <div>
          <Link
            href="/organizations"
            className="text-sm underline-offset-4 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2"
          >
            ← {t.orgs.back}
          </Link>
        </div>
      </div>
    );
  }

  return (
    <div className="grid gap-3">
      <h1 className="text-2xl font-semibold">{t.orgs.inviteAccepted}</h1>
      <p className="text-muted-foreground text-sm">{t.orgs.inviteAcceptedDesc}</p>
    </div>
  );
}

export default function AcceptInvitePage() {
  return (
    <Suspense fallback={null}>
      <AcceptInviteInner />
    </Suspense>
  );
}
