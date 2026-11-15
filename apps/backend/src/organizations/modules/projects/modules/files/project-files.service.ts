import {
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
  UnauthorizedException,
  forwardRef,
} from '@nestjs/common';
import path from 'node:path';
import type { Stats } from 'node:fs';
import { AppLogger } from '@common/logger';
import { ExternalServiceError } from '@common/external/external-error';
import { storageUnavailable, throwStorageNotConfigured } from '@common/storage/storage-unavailable';
import { ProjectAccessService } from '../project-access/project-access.service';
import {
  WorkspacePathService,
  type DirEntry,
  type ProjectResolved,
} from '@common/storage/workspace-path.service';
import { ProjectsService, type Project } from '../../projects.service';

export type FileNode = {
  path: string;
  type: 'file' | 'dir';
  children?: Array<FileNode>;
};

const MAX_DEPTH: number = 5;

/**
 * Project file browser over the org layout
 * (orgs/<orgUuid>/projects/<id>/content, jailed per project).
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
    private readonly logger: AppLogger = new AppLogger(ProjectFilesService.name),
    private readonly access: ProjectAccessService,
  ) {}

  /**
   * Unified jail root — REPOS_ROOT only, no fallback. Empty REPOS_ROOT →
   * 503 EXTERNAL_UNAVAILABLE (storage-unconfigured deny, never silently read
   * <cwd>/repos or the process cwd, never answer a quiet 404 over an
   * unconfigured root). Jail/traversal checks run after this gate.
   */
  resolveRoot(): string {
    const repos: string = (process.env.REPOS_ROOT ?? '').trim();
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
    if (!requesterId) {
      throw new UnauthorizedException({
        code: 'unauthorized',
        message: 'Authentication required',
      });
    }
    // Storage gate first (before any DB branching): empty REPOS_ROOT →
    // 503 EXTERNAL_UNAVAILABLE via storageUnavailable (single deny log
    // line), never a silent 404 over an unconfigured root — consistent
    // with the repos/workspaces/clone deny cases.
    try {
      this.resolveRoot();
    } catch (error) {
      if (error instanceof ExternalServiceError && error.code === 'EXTERNAL_UNAVAILABLE') {
        storageUnavailable('project-files.tree', this.logger, correlationId, error);
      }
      throw error;
    }
    const project: Project = await this.projects.getOrThrow(projectId, correlationId);
    // Card 5 access layer, always enforced: org members only (membership
    // via ProjectAccessService.assertProjectAccess); strangers → 404
    // (existence is not leaked). A missing requester is a fail-closed 401
    // (checked above).
    await this.access.assertProjectAccess(
      project.id,
      project.ownerId,
      requesterId,
      correlationId,
    );
    const clamped: number = Math.min(Math.max(depth, 0), MAX_DEPTH);
    // The org home determines the content jail (access already gated above).
    let absolutePath: string;
    let relativePath: string;
    try {
      if (!project.orgId) {
        throw new NotFoundException(`Path ${requestedPath} not found`);
      }
      const resolved: ProjectResolved = await this.paths.resolveOrg(
        project.orgId,
        project.id,
        requestedPath || '.',
      );
      absolutePath = resolved.absolutePath;
      relativePath = resolved.relativePath;
    } catch (error) {
      if (error instanceof ExternalServiceError && error.code === 'EXTERNAL_UNAVAILABLE') {
        // Unconfigured REPOS_ROOT → single deny log line, 503 propagates
        // (never a silent 404 over <cwd>/repos).
        storageUnavailable('project-files.tree', this.logger, correlationId, error);
      }
      if (error instanceof ForbiddenException) throw error;
      // BadRequest here means the stored row carries a non-uuid id
      // (hand-migration pending) — surface 404, never 400 for a stored row.
      throw new NotFoundException(`Path ${requestedPath} not found`);
    }
    try {
      return await this.readNode(
        absolutePath,
        relativePath === '.' ? '.' : relativePath,
        clamped,
      );
    } catch (error) {
      if (error instanceof ForbiddenException) throw error;
      throw new NotFoundException(`Path ${requestedPath} not found`);
    }
  }

  private async readNode(
    absolutePath: string,
    relativePath: string,
    depth: number,
  ): Promise<FileNode> {
    let entries: Array<DirEntry>;
    try {
      entries = await this.paths.readDir(absolutePath);
    } catch {
      // Single file (or missing) — surface the file node; missing → caller 404.
      try {
        const stats: Stats | null = await this.paths.statPath(absolutePath);
        if (stats?.isFile()) return { path: relativePath, type: 'file' };
      } catch {
        throw new NotFoundException(`Path ${relativePath} not found`);
      }
      return { path: relativePath, type: 'file' };
    }
    const node: FileNode = { path: relativePath, type: 'dir', children: [] };
    if (depth <= 0) return node;
    // Deterministic order, bounded fan-out for depth-capped listings.
    const sorted: Array<DirEntry> = entries
      .sort((left, right) => left.name.localeCompare(right.name))
      .slice(0, 200);
    for (const entry of sorted) {
      const childRelativePath: string =
        relativePath === '.' ? entry.name : `${relativePath}/${entry.name}`;
      if (entry.isDirectory()) {
        if (depth > 1) {
          try {
            node.children!.push(
              await this.readNode(
                path.join(absolutePath, entry.name),
                childRelativePath,
                depth - 1,
              ),
            );
          } catch {
            node.children!.push({ path: childRelativePath, type: 'dir' });
          }
        } else {
          node.children!.push({ path: childRelativePath, type: 'dir' });
        }
      } else {
        node.children!.push({ path: childRelativePath, type: 'file' });
      }
    }
    return node;
  }
}
