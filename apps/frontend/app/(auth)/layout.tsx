import type { ReactNode } from 'react';
import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { AuthHeader } from '@/components/auth-header';
import { AUTH_MARKER, AUTH_MARKER_VALUE } from '@/lib/route-guard';

/**
 * Route-group layout for (auth): flat URL /login.
 * Guest shell mirroring the dashboard Header (kit Header shape=rounded
 * via AuthHeader: SidebarBrand leading + LanguageSwitcher compact /
 * ThemeToggleDefault trailing, no profile/menu) + borderless centered
 * content (main > .auth-shell-inner, max 28rem). No sidebar, no Card
 * frames in the shell — the login Card is the page's own form.
 * force-dynamic: login is a client form with useRouter — no static prerender.
 *
 * Server guard (defense-in-depth behind edge `proxy.ts`): a session marker
 * on an unauth page means an authed user — bounce to `/projects` (no
 * /login<->/projects loop: `/projects` never redirects authed users back).
 */
export const dynamic = 'force-dynamic';

export default async function AuthGroupLayout({ children }: { children: ReactNode }) {
  const store = await cookies();
  if (store.get(AUTH_MARKER)?.value === AUTH_MARKER_VALUE) redirect('/projects');
  return (
    <div className="auth-shell">
      <a href="#main-content" className="sr-only focus:not-sr-only">
        Skip to content
      </a>
      <AuthHeader />
      <main id="main-content">
        <div className="auth-shell-inner">{children}</div>
      </main>
    </div>
  );
}
