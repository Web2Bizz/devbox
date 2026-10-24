import { Module, forwardRef } from '@nestjs/common';
import { OrganizationsModule } from '../../organizations/organizations.module';
import { WorkspacePathService } from '../../workspaces/workspace-path.service';
import { ProjectsModule } from '../projects.module';
import { ProjectFilesController } from './project-files.controller';
import { ProjectFilesService } from './project-files.service';

/**
 * Nested readonly module — imported by ProjectsModule only.
 * WorkspacePathService is provided directly (stateless, same pattern as
 * ProjectsModule — avoids a ProjectsModule ↔ WorkspacesModule cycle).
 * OrganizationsModule supplies the Card 5 access gate (member-or-owner
 * scoping, no cycle: orgs import only DbModule).
 */
@Module({
  imports: [forwardRef(() => ProjectsModule), OrganizationsModule],
  controllers: [ProjectFilesController],
  providers: [ProjectFilesService, WorkspacePathService],
  exports: [ProjectFilesService],
})
export class ProjectFilesModule {}
