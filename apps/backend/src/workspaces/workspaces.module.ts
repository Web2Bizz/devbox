import { Module, forwardRef } from '@nestjs/common';
import { GithubModule } from '../projects/github/github.module';
import { CloneJobsRepository } from './clone-jobs.repository';
import { WorkspaceCloneService } from './workspace-clone.service';
import { WorkspacePathService } from './workspace-path.service';
import { WorkspacesController } from './workspaces.controller';
import { WorkspacesService } from './workspaces.service';

/**
 * WorkspacesModule — per-user workspace surface.
 *
 * - WorkspacePathService: per-user jail
 *   (REPOS_ROOT/<userSpace(userId)>/workspace/<repo>[/subPath]) — exported
 *   so repos/projects/opencode can reuse one jail instead of forking it.
 * - WorkspaceCloneService + CloneJobsRepository: idempotent
 *   `git clone --recurse-submodules` lifecycle (queued→cloning→ready/failed).
 * - WorkspacesService: readonly jailed tree + submodule reads.
 * - Imports GithubModule (forwardRef) for the installation-ownership check
 *   only (installation must belong to the requesting userId, else 403);
 *   GithubModule stays the single owner of the installations registry —
 *   no second instance, no forked state.
 */
@Module({
  imports: [forwardRef(() => GithubModule)],
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
