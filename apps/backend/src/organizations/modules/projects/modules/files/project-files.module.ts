import { Module, forwardRef } from '@nestjs/common';
import { WorkspacePathService } from '@common/storage/workspace-path.service';
import { ProjectAccessModule } from '../project-access/project-access.module';
import { ProjectsModule } from '../../projects.module';
import { ProjectFilesController } from './project-files.controller';
import { ProjectFilesService } from './project-files.service';

/**
 * Nested readonly module — imported by ProjectsModule only.
 * WorkspacePathService is provided directly (stateless, same pattern as
 * ProjectsModule — avoids a ProjectsModule ↔ WorkspacesModule cycle).
 * ProjectAccessModule (sibling) supplies the C4 gate (member-or-owner
 * scoping), so files no longer reach up into the organizations module.
 */
@Module({
  imports: [forwardRef(() => ProjectsModule), ProjectAccessModule],
  controllers: [ProjectFilesController],
  providers: [ProjectFilesService, WorkspacePathService],
  exports: [ProjectFilesService],
})
export class ProjectFilesModule {}
