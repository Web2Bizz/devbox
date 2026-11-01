import { Module } from "@nestjs/common";
import { WorkspacePathService } from "../../../common/storage/workspace-path.service";
import { OrganizationsGuard } from "../../organizations.guard";
import { MembersService } from "./members.service";

/**
 * MembersModule — org membership (list/add/remove/change-role) as a nested
 * module of OrganizationsModule (`organizations/modules/members/`, CoC §2).
 * Imported by OrganizationsModule only; never registered in AppModule and
 * never re-exported outside the domain.
 *
 * WorkspacePathService and OrganizationsGuard are provided directly (both
 * stateless, same documented pattern as ProjectsModule) — importing
 * OrganizationsModule here would be a cycle. UsersService comes from the
 * global UsersModule, DbService from the global CommonModule.
 */
@Module({
  providers: [MembersService, WorkspacePathService, OrganizationsGuard],
  exports: [MembersService],
})
export class MembersModule {}
