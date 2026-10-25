/**
 * Nested navigation helpers (1:1 org→project model).
 * Single source for nested URL construction — no hardcoded
 * `/organizations/.../projects/...` strings in components.
 */

export function orgPath(orgId: string): string {
  return `/organizations/${encodeURIComponent(orgId)}`;
}

export function orgProjectsPath(orgId: string): string {
  return `/organizations/${encodeURIComponent(orgId)}/projects`;
}

export function projectPath(orgId: string, projectId: string): string {
  return `/organizations/${encodeURIComponent(orgId)}/projects/${encodeURIComponent(projectId)}`;
}

export function projectSessionPath(orgId: string, projectId: string, sessionId: string): string {
  return `/organizations/${encodeURIComponent(orgId)}/projects/${encodeURIComponent(projectId)}/sessions/${encodeURIComponent(sessionId)}`;
}

export function projectSecretsPath(orgId: string, projectId: string): string {
  return `${projectPath(orgId, projectId)}/secrets`;
}

export function projectAiPath(orgId: string, projectId: string): string {
  return `${projectPath(orgId, projectId)}/ai-providers`;
}

/** Project-shell nav items (project-scoped, org switcher carries orgId). */
export function projectNavItems(orgId: string, projectId: string): { label: string; href: string }[] {
  const base = projectPath(orgId, projectId);
  return [
    { label: 'Overview', href: base },
    { label: 'Sessions', href: `${base}/sessions` },
    { label: 'Secrets', href: `${base}/secrets` },
    { label: 'AI Providers', href: `${base}/ai-providers` },
    { label: 'Registry', href: `${base}/registry` },
  ];
}

/** Legacy global → nested redirect target (deleted/foreign → 404, not leak). */
export function isLegacyProjectPath(pathname: string): boolean {
  return pathname === '/projects' || pathname.startsWith('/projects/');
}
