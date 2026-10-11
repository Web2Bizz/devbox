import { redirect } from 'next/navigation';

/**
 * Route: /chat → server redirect to /projects (session = chat).
 * Chats now live at /projects/[id]/sessions/[sessionId], chosen/created
 * from SessionsTab. The t.nav.chat / t.chat.* i18n keys stay until the
 * redirect itself is removed.
 */
export default function ChatRedirectPage() {
  redirect('/projects');
}
