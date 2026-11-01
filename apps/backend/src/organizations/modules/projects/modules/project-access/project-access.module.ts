import { Module } from "@nestjs/common";
import { OrganizationsGuard } from "../../../../organizations.guard";
import { ProjectAccessService } from "./project-access.service";

/**
 * ProjectAccessModule — the C4 access gate of the projects domain
 * (CoC §2: nested under `organizations/modules/projects/modules/`).
 *
 * No imports: DbService + AppLogger come from the global CommonModule.
 * OrganizationsGuard is stateless (a policy helper over DbService) and is
 * provided directly here instead of pulling the organizations module in —
 * the same "provided directly" pattern as WorkspacePathService, and the
 * reason ProjectsModule/chats/sessions/files no longer point back up at the
 * organizations module.
 *
 * Exported by ProjectsModule, so project-internal consumers import
 * ProjectAccessModule and external domains reach it transitively via
 * the organizations module → ProjectsModule → ProjectAccessModule.
 */
@Module({
  providers: [ProjectAccessService, OrganizationsGuard],
  exports: [ProjectAccessService],
})
export class ProjectAccessModule {}
