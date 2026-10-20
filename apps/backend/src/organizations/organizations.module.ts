import { Module } from "@nestjs/common";
import { DbModule } from "../db/db.module";
import { WorkspacePathService } from "../workspaces/workspace-path.service";
import { OrganizationsController } from "./organizations.controller";
import { OrganizationsService } from "./organizations.service";

/**
 * OrganizationsModule — org CRUD + membership + invites + project links.
 * Imports DbModule only (UsersService comes from the global AuthModule —
 * no import needed, no cycle). WorkspacePathService is provided directly
 * (stateless, same pattern as ProjectsModule). Exported for the project
 * access layer (ProjectsModule consumes it via forwardRef in Card 5).
 */
@Module({
  imports: [DbModule],
  controllers: [OrganizationsController],
  providers: [OrganizationsService, WorkspacePathService],
  exports: [OrganizationsService],
})
export class OrganizationsModule {}
