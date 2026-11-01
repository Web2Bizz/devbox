import { Module } from '@nestjs/common';
import { WorkspacePathService } from './path.service';

/**
 * PathModule — scoped path jail for projects (REPOS_ROOT strict, no
 * `workspace` segment). Stateless — consumers may either import this
 * module or provide WorkspacePathService directly (same pattern as
 * ProjectsModule/OpencodeModule).
 */
@Module({
  providers: [WorkspacePathService],
  exports: [WorkspacePathService],
})
export class PathModule {}
