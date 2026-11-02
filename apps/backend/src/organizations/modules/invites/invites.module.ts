import { Module } from "@nestjs/common";
import { WorkspacePathService } from "../../../common/storage/workspace-path.service";
import { OrganizationsGuard } from "../../organizations.guard";
import { InvitesController } from "./invites.controller";
import { InvitesService } from "./invites.service";

/**
 * InvitesModule — persistent single-use uuidv7 invites as a nested module of
 * OrganizationsModule (`organizations/modules/invites/`, CoC §2). Imported by
 * OrganizationsModule only; never registered in AppModule and never
 * re-exported outside the domain.
 *
 * The module owns its HTTP surface: InvitesController serves
 * POST /organizations/:id/invites + POST /organizations/invites/accept
 * (CoC §1.1 — the parent OrganizationsController carries only
 * /organizations CRUD).
 *
 * WorkspacePathService and OrganizationsGuard are provided directly (both
 * stateless, same documented pattern as ProjectsModule) — importing
 * OrganizationsModule here would be a cycle. UsersService comes from the
 * global UsersModule, DbService from the global CommonModule.
 */
@Module({
  controllers: [InvitesController],
  providers: [InvitesService, WorkspacePathService, OrganizationsGuard],
  exports: [InvitesService],
})
export class InvitesModule {}
