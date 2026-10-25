/**
 * Route: / → plain landing (no sidebar). Authed users go to /organizations
 * via the edge proxy; this render is the guest/no-JS fallback.
 */
export const dynamic = 'force-dynamic';

import Link from 'next/link';

export default function RootPage() {
  return (
    <main className="mx-auto max-w-2xl px-6 py-16" data-shell="plain">
      <h1 className="text-3xl font-semibold">Rush Code</h1>
      <p className="text-muted-foreground mt-2 text-sm">
        Console — organizations first. Sign in to continue.
      </p>
      <div className="mt-6 flex gap-2">
        <Link href="/login" className="underline underline-offset-4 text-sm">
          Sign in →
        </Link>
        <Link href="/organizations" className="underline underline-offset-4 text-sm">
          Organizations →
        </Link>
      </div>
    </main>
  );
}