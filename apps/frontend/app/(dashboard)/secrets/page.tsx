import Link from 'next/link';

export const dynamic = 'force-dynamic';

/**
 * Gone global (410): this surface now lives under the organization/project.
 * No auto-redirect (no org guess) — explicit CTA to /organizations.
 */
export default function GoneGlobal() {
  return (
    <main className="mx-auto max-w-xl px-6 py-16" data-shell="plain">
      <h1 className="text-2xl font-semibold">410 — moved under organization</h1>
      <p className="text-muted-foreground mt-2 text-sm">
        This page moved to /organizations/[orgId]/projects/[projectId]/…. Pick an organization to continue.
      </p>
      <Link href="/organizations" className="mt-6 inline-block underline underline-offset-4 text-sm">
        ← Back to organizations
      </Link>
    </main>
  );
}
