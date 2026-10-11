import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { AppLogger } from '../common/app-logger.service.js';
import { ExternalServiceError } from '../common/external/external-error.js';
import { storageUnavailable } from '../storage/storage-unavailable.js';
import { WorkspacePathService } from './workspace-path.service.js';
import { readSubmodules, type SubmoduleEntry } from './workspace-submodules.util.js';

export interface WorkspaceTreeNode {
  path: string;
  type: 'file' | 'dir';
  children?: WorkspaceTreeNode[];
}

const MAX_DEPTH = 5;
const MAX_ENTRIES = 200;

/**
 * WorkspacesService — per-user project content browser over the unified
 * REPOS_ROOT (organizations layout, no `workspace` segment).
 *
 * Every listing is jailed through WorkspacePathService.resolveUser
 * (REPOS_ROOT/users/<userUuid>/projects/<projectUuid>/content[/subPath],
 * both ids uuid-validated — 400 on garbage): unconfigured storage denies
 * with 503 EXTERNAL_UNAVAILABLE (Retry-After 30, logged once with the
 * correlationId — never a silent []/404 over <cwd>/repos), traversal yields
 * 403, missing paths 404. Readonly — readdir/stat only, never writes.
 * Submodule reads delegate to workspace-submodules.util (unsafe gitlinks
 * skipped).
 */
@Injectable()
export class WorkspacesService {
  constructor(
    private readonly paths: WorkspacePathService,
    private readonly logger: AppLogger = new AppLogger('WorkspacesService'),
  ) {}

  async tree(
    userId: string,
    repo: string,
    requestedPath: string,
    depth: number,
    correlationId?: string,
  ): Promise<WorkspaceTreeNode> {
    const clamped = Math.min(Math.max(Number(depth) || 0, 0), MAX_DEPTH);
    let resolved: Awaited<ReturnType<typeof this.paths.resolveUser>>;
    try {
      resolved = await this.paths.resolveUser(userId, repo, requestedPath);
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
  ): Promise<SubmoduleEntry[]> {
    let resolved: Awaited<ReturnType<typeof this.paths.resolveUser>>;
    try {
      resolved = await this.paths.resolveUser(userId, repo);
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
      `[workspaces] submodules listed users/${resolved.scopeId}/projects/${resolved.projectId} (${entries.length})`,
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
