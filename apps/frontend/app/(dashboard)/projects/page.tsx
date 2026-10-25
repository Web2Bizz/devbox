import { redirect } from 'next/navigation';

export const dynamic = 'force-dynamic';

/**
 * Legacy global /projects → canonical /organizations (no orgId → no
 * fallback to first org, explicit redirect).
 */
export default function LegacyProjectsRedirect() {
  redirect('/organizations');
}
