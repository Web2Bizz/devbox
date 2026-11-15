import { Module } from '@nestjs/common';
import { CloneJobsRepository } from './clone-jobs.repository';
import { WorkspaceCloneService } from './workspace-clone.service';

/**
 * CloneModule — idempotent per-user `git clone` lifecycle
 * (WorkspaceCloneService + CloneJobsRepository, queued→cloning→ready/failed).
 * WorkspacePathService comes from the caller (same stateless pattern as
 * PathModule consumers) to avoid a jobs→path module dependency.
 */
@Module({
  providers: [CloneJobsRepository, WorkspaceCloneService],
  exports: [CloneJobsRepository, WorkspaceCloneService],
})
export class CloneModule {}
