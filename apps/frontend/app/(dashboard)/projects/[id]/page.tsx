import Link from 'next/link';

export const dynamic = 'force-dynamic';

/**
 * Legacy /projects/[id] interceptor: the global id carries no org, and the
 * 1:1 model forbids guessing — render 404 + CTA to /organizations instead
 * of a 308 guess. Deleted/foreign nested ids also 404 (no leak).
 */
export default function LegacyProjectDetail() {
  return (
    <main className="mx-auto max-w-xl px-6 py-16" data-shell="plain">
      <h1 className="text-2xl font-semibold">Project moved</h1>
      <p className="text-muted-foreground mt-2 text-sm">
        Projects now live under their organization: /organizations/[orgId]/projects/[projectId].
      </p>
      <Link href="/organizations" className="mt-6 inline-block underline underline-offset-4 text-sm">
        ← Back to organizations
      </Link>
    </main>
  );
}
