import { Module } from "@nestjs/common";
import { WorkspacePathService } from "@common/storage/workspace-path.service";
import { OrganizationsGuard } from "../../organizations.guard";
import { MembersController } from "./members.controller";
import { MembersService } from "./members.service";

/**
 * MembersModule — org membership (list/add/remove/change-role) as a nested
 * module of OrganizationsModule (`organizations/modules/members/`, CoC §2).
 * Imported by OrganizationsModule only; never registered in AppModule and
 * never re-exported outside the domain.
 *
 * The module owns its HTTP surface: MembersController serves
 * /organizations/:id/members* (CoC §1.1 — the parent OrganizationsController
 * carries only /organizations CRUD).
 *
 * WorkspacePathService and OrganizationsGuard are provided directly (both
 * stateless, same documented pattern as ProjectsModule) — importing
 * OrganizationsModule here would be a cycle. UsersService comes from the
 * global UsersModule, DbService from the global CommonModule.
 */
@Module({
  controllers: [MembersController],
  providers: [MembersService, WorkspacePathService, OrganizationsGuard],
  exports: [MembersService],
})
export class MembersModule {}
