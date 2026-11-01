import { Module } from "@nestjs/common";
import { WorkspacePathService } from "../common/storage/workspace-path.service";
import { InvitesModule } from "./modules/invites/invites.module";
import { MembersModule } from "./modules/members/members.module";
import { ProjectsModule } from "./modules/projects/projects.module";
import { RegistriesModule } from "./modules/registries/registries.module";
import { OrganizationsController } from "./organizations.controller";
import { OrganizationsGuard } from "./organizations.guard";
import { OrganizationsService } from "./organizations.service";

/**
 * OrganizationsModule — org CRUD + membership + invites + project links.
 * Owns ProjectsModule + RegistriesModule + MembersModule + InvitesModule as
 * nested modules (CoC §2: `organizations/modules/`; nested modules are never
 * registered in AppModule and are not re-exported outside the domain).
 *
 * Membership lives in MembersModule and invites in InvitesModule; this module
 * imports them and OrganizationsService delegates to their services, so its
 * public API (and the thin controller) stays unchanged. The access gate
 * (OrganizationsGuard) is a domain-root provider here and in each nested
 * module that needs it — the guard is stateless, so per-module instances are
 * safe (no cycle back into OrganizationsModule).
 *
 * UsersService comes from the global UsersModule — no import needed, no
 * cycle; DbService is a provider of the global CommonModule. CryptoService
 * and OpencodeKeysService are global too (their HTTP surface lives in ai).
 * WorkspacePathService is provided directly (stateless, common/storage).
 * Re-exports ProjectsModule + RegistriesModule so existing consumers keep
 * working.
 */
@Module({
  imports: [ProjectsModule, RegistriesModule, MembersModule, InvitesModule],
  controllers: [OrganizationsController],
  providers: [
    OrganizationsService,
    OrganizationsGuard,
    WorkspacePathService,
  ],
  exports: [OrganizationsService, ProjectsModule, RegistriesModule],
})
export class OrganizationsModule {}
