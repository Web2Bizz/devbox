import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { AppLogger } from '../../../../../../../common/logger';
import { ExternalServiceError } from '../../../../../../../common/external/external-error';
import { storageUnavailable } from '../../../../../../../common/storage/storage-unavailable';
import { WorkspacePathService } from '../../../../../../../common/storage/workspace-path.service';
import { readSubmodules, type SubmoduleEntry } from '../../utils/submodules';

export type WorkspaceTreeNode = {
  path: string;
  type: 'file' | 'dir';
  children?: Array<WorkspaceTreeNode>;
};

const MAX_DEPTH = 5;
const MAX_ENTRIES = 200;

/**
 * WorkspacesService — org-scoped project content browser over the unified
 * REPOS_ROOT (orgs layout, no `workspace` segment).
 *
 * Every listing is jailed through WorkspacePathService.resolveOrg
 * (REPOS_ROOT/orgs/<orgUuid>/projects/<projectUuid>/content[/subPath],
 * both ids uuid-validated — 400 on garbage): unconfigured storage denies
 * with 503 EXTERNAL_UNAVAILABLE (Retry-After 30, logged once with the
 * correlationId — never a silent []/404 over <cwd>/repos), traversal yields
 * 403, missing paths 404. Readonly — readdir/stat only, never writes.
 * Submodule reads delegate to utils/submodules (unsafe gitlinks
 * skipped).
 *
 * User homes (users/<userUuid>/…) are removed (org-only model): the
 * (userId, repo) args are the org id + project id of the project home.
 */
@Injectable()
export class WorkspacesService {
  constructor(
    private readonly paths: WorkspacePathService,
    private readonly logger: AppLogger = new AppLogger(WorkspacesService.name),
  ) {}

  async tree(
    userId: string,
    repo: string,
    requestedPath: string,
    depth: number,
    correlationId?: string,
  ): Promise<WorkspaceTreeNode> {
    const clamped = Math.min(Math.max(Number(depth) || 0, 0), MAX_DEPTH);
    let resolved: Awaited<ReturnType<typeof this.paths.resolveOrg>>;
    try {
      resolved = await this.paths.resolveOrg(userId, repo, requestedPath);
    } catch (err) {
      if (err instanceof ExternalServiceError && err.code === 'EXTERNAL_UNAVAILABLE') {
        // Unconfigured REPOS_ROOT → single deny log line, 503 propagates.
        storageUnavailable('workspaces.tree', this.logger, correlationId, err);
      }
      throw err;
    }
    try {
      return await this.readNode(resolved.abs, resolved.rel, clamped);
    } catch (err) {
      if (err instanceof ForbiddenException) throw err;
      throw new NotFoundException(`Path ${requestedPath} not found`);
    }
  }

  async submodules(
    userId: string,
    repo: string,
    correlationId?: string,
  ): Promise<Array<SubmoduleEntry>> {
    let resolved: Awaited<ReturnType<typeof this.paths.resolveOrg>>;
    try {
      resolved = await this.paths.resolveOrg(userId, repo);
    } catch (err) {
      if (err instanceof ExternalServiceError && err.code === 'EXTERNAL_UNAVAILABLE') {
        storageUnavailable('workspaces.submodules', this.logger, correlationId, err);
      }
      throw err;
    }
    try {
      const st = await stat(resolved.absRepo);
      if (!st.isDirectory()) throw new NotFoundException(`Repo ${repo} not found`);
    } catch (err) {
      if (err instanceof ForbiddenException) throw err;
      throw new NotFoundException(`Repo ${repo} not found`);
    }
    const entries = await readSubmodules(resolved.absRepo, this.logger);
    // Per-request listing on a hot path → debug (not info); ids only, no secrets.
    this.logger.debug(
      `[workspaces] submodules listed orgs/${resolved.scopeId}/projects/${resolved.projectId} (${entries.length})`,
    );
    return entries;
  }

  private async readNode(abs: string, rel: string, depth: number): Promise<WorkspaceTreeNode> {
    let entries;
    try {
      entries = await readdir(abs, { withFileTypes: true });
    } catch {
      try {
        const st = await stat(abs);
        if (st.isFile()) return { path: rel, type: 'file' };
      } catch {
        throw new NotFoundException(`Path ${rel} not found`);
      }
      return { path: rel, type: 'file' };
    }
    const node: WorkspaceTreeNode = { path: rel, type: 'dir', children: [] };
    if (depth <= 0) return node;
    const sorted = entries.sort((a, b) => a.name.localeCompare(b.name)).slice(0, MAX_ENTRIES);
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
