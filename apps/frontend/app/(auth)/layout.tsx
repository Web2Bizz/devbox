import type { ReactNode } from 'react';
import { AuthHeader } from '../../src/components/auth-header';

/**
 * Route-group layout for (auth): flat URL /login.
 * Guest shell mirroring the dashboard Header (kit Header shape=rounded
 * via AuthHeader: SidebarBrand leading + LanguageSwitcher compact /
 * ThemeToggleDefault trailing, no profile/menu) + borderless centered
 * content (main > .auth-shell-inner, max 28rem). No sidebar, no Card
 * frames in the shell — the login Card is the page's own form.
 * force-dynamic: login is a client form with useRouter — no static prerender.
 */
export const dynamic = 'force-dynamic';

export default function AuthGroupLayout({ children }: { children: ReactNode }) {
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
