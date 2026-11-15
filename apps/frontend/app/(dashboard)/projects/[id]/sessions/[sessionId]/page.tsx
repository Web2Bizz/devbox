import Link from 'next/link';

export const dynamic = 'force-dynamic';

/** Legacy /projects/[id]/sessions/[sessionId] interceptor: id carries no org — 404 + CTA. */
export default function LegacySessionDetail() {
  return (
    <main className="mx-auto max-w-xl px-6 py-16" data-shell="plain">
      <h1 className="text-2xl font-semibold">Session moved</h1>
      <p className="text-muted-foreground mt-2 text-sm">
        Sessions now live under /organizations/[orgId]/projects/[projectId]/sessions/[sessionId].
      </p>
      <Link href="/organizations" className="mt-6 inline-block underline underline-offset-4 text-sm">
        ← Back to organizations
      </Link>
    </main>
  );
}
