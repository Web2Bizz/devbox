import { Module } from "@nestjs/common";
import { GithubModule } from "../../../github/github.module";
import { WorkspacePathService } from "../../../../../../../common/storage/workspace-path.service";
import { CloneJobsRepository } from "./modules/clone/clone-jobs.repository";
import { WorkspaceCloneService } from "./modules/clone/workspace-clone.service";
import { WorkspacesController } from "./workspaces.controller";
import { WorkspacesService } from "./workspaces.service";

/**
 * WorkspacesModule — org-scoped project-content surface (nested in the projects
 * domain via RepositoryModule, CoC §2).
 *
 * - WorkspacePathService: the single jail
 *   (REPOS_ROOT/orgs/<orgId>/projects/<projectId>/content) — a
 *   stateless common/storage service; exported so repos/projects/opencode
 *   reuse one jail instead of forking it.
 * - WorkspaceCloneService + CloneJobsRepository: idempotent
 *   `git clone --recurse-submodules` lifecycle (queued→cloning→ready/failed).
 * - WorkspacesService: readonly jailed tree + submodule reads.
 * - Imports GithubModule for the installation-ownership check only
 *   (installation must belong to the requesting userId, else 403);
 *   GithubModule stays the single owner of the installations registry —
 *   no second instance, no forked state. GithubModule depends on nothing in
 *   the projects domain, so this import is direct (no forwardRef, no cycle).
 */
@Module({
  imports: [GithubModule],
  controllers: [WorkspacesController],
  providers: [
    WorkspacePathService,
    CloneJobsRepository,
    WorkspaceCloneService,
    WorkspacesService,
  ],
  exports: [WorkspacePathService, CloneJobsRepository, WorkspaceCloneService, WorkspacesService],
})
export class WorkspacesModule {}
