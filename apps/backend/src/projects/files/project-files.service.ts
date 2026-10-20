import { ForbiddenException, Inject, Injectable, NotFoundException, forwardRef } from '@nestjs/common';
import { readdir } from 'node:fs/promises';
import path from 'node:path';
import { AppLogger } from '../../common/app-logger.service';
import { ExternalServiceError } from '../../common/external/external-error';
import { storageUnavailable, throwStorageNotConfigured } from '../../storage/storage-unavailable';
import { OrganizationsService } from '../../organizations/organizations.service';
import { WorkspacePathService } from '../../workspaces/workspace-path.service';
import { ProjectsService, ownerKeyOrThrow } from '../projects.service';

export type FileNode = {
  path: string;
  type: 'file' | 'dir';
  children?: FileNode[];
};

const MAX_DEPTH = 5;

/**
 * Project file browser over the organizations layout
 * (users/<ownerUuid>/projects/<id>/content, jailed per project).
 * Every path is normalized + jailed inside the project content dir;
 * traversal attempts yield 403, unconfigured storage denies with 503
 * EXTERNAL_UNAVAILABLE (Retry-After 30, logged once with the
 * correlationId — never a silent []/404 over <cwd>/repos, never a read
 * outside the explicit root). Depth is clamped to 0-5 (default 1).
 * `.secrets` reserves are unreachable: every request is anchored under
 * `content`, `../.secrets` escapes 403.
 */
@Injectable()
export class ProjectFilesService {
  constructor(
    @Inject(forwardRef(() => ProjectsService))
    private readonly projects: ProjectsService,
    private readonly paths: WorkspacePathService,
    private readonly logger: AppLogger = new AppLogger('ProjectFilesService'),
    private readonly orgs?: OrganizationsService,
  ) {}

  /**
   * Unified jail root — REPOS_ROOT only, no fallback. Empty REPOS_ROOT →
   * 503 EXTERNAL_UNAVAILABLE (storage-unconfigured deny, never silently read
   * <cwd>/repos or the process cwd, never answer a quiet 404 over an
   * unconfigured root). Jail/traversal checks run after this gate.
   */
  resolveRoot(): string {
    const repos = (process.env.REPOS_ROOT ?? '').trim();
    if (!repos) throwStorageNotConfigured('project-files.resolveRoot');
    return path.resolve(repos);
  }

  async tree(
    projectId: string,
    requestedPath: string,
    depth: number,
    correlationId?: string,
    requesterId?: string,
  ): Promise<FileNode> {
    const project = await this.projects.getOrThrow(projectId, correlationId);
    // Card 5 access layer: org-linked → any linked-org member, user-space →
    // owner only, strangers → 404 (existence is not leaked). Skipped only
    // when the requester is absent (internal/test callers) or the access
    // service is not wired (manual `new` in unit specs like
    // storage-unavailable.spec). Disk homes are NOT moved by linking
    // (metadata-only join rows) — the user home below stays canonical.
    if (requesterId && this.orgs) {
      await this.orgs.assertProjectAccess(
        project.id,
        project.ownerId,
        requesterId,
        correlationId,
      );
    }
    const clamped = Math.min(Math.max(depth, 0), MAX_DEPTH);
    // Owner home determines the content jail (access already gated above
    // via OrganizationsService.assertProjectAccess — Card 5; legacy non-uuid
    // owners have no home here → 404, never an unscoped read).
    let abs: string;
    let rel: string;
    try {
      const ownerKey = ownerKeyOrThrow(project.ownerId);
      const resolved = await this.paths.resolveUser(
        ownerKey,
        project.id,
        requestedPath || '.',
      );
      abs = resolved.abs;
      rel = resolved.rel;
    } catch (err) {
      if (err instanceof ExternalServiceError && err.code === 'EXTERNAL_UNAVAILABLE') {
        // Unconfigured REPOS_ROOT → single deny log line, 503 propagates
        // (never a silent 404 over <cwd>/repos).
        storageUnavailable('project-files.tree', this.logger, correlationId, err);
      }
      if (err instanceof ForbiddenException) throw err;
      // BadRequest here means the stored row predates the uuid layout
      // (hand-migration pending) — surface 404, never 400 for a stored row.
      throw new NotFoundException(`Path ${requestedPath} not found`);
    }
    try {
      return await this.readNode(abs, rel === '.' ? '.' : rel, clamped);
    } catch (err) {
      if (err instanceof ForbiddenException) throw err;
      throw new NotFoundException(`Path ${requestedPath} not found`);
    }
  }

  private async readNode(abs: string, rel: string, depth: number): Promise<FileNode> {
    let entries;
    try {
      entries = await readdir(abs, { withFileTypes: true });
    } catch {
      // Single file (or missing) — surface the file node; missing → caller 404.
      const { stat } = await import('node:fs/promises');
      try {
        const st = await stat(abs);
        if (st.isFile()) return { path: rel, type: 'file' };
      } catch {
        throw new NotFoundException(`Path ${rel} not found`);
      }
      return { path: rel, type: 'file' };
    }
    const node: FileNode = { path: rel, type: 'dir', children: [] };
    if (depth <= 0) return node;
    // Deterministic order, bounded fan-out for depth-capped listings.
    const sorted = entries.sort((a, b) => a.name.localeCompare(b.name)).slice(0, 200);
    for (const entry of sorted) {
      const childRel = rel === '.' ? entry.name : `${rel}/${entry.name}`;
      if (entry.isDirectory()) {
        if (depth > 1) {
          try {
            node.children!.push(await this.readNode(path.join(abs, entry.name), childRel, depth - 1));
          } catch {
            node.children!.push({ path: childRel, type: 'dir' });
          }
        } else {
          node.children!.push({ path: childRel, type: 'dir' });
        }
      } else {
        node.children!.push({ path: childRel, type: 'file' });
      }
    }
    return node;
  }
}
