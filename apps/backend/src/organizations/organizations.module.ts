import { Module } from "@nestjs/common";
import { DbModule } from "../common/db/db.module";
import { WorkspacePathService } from "../workspaces/modules/path/path.service";
import { CryptoModule } from "./modules/crypto/crypto.module";
import { KeysModule } from "./modules/keys/keys.module";
import { ProjectsModule } from "./modules/projects/projects.module";
import { RegistriesModule } from "./modules/registries/registries.module";
import { OrgProjectsController } from "./org-projects.controller";
import { OrganizationsController } from "./organizations.controller";
import { OrganizationsService } from "./organizations.service";

/**
 * OrganizationsModule — org CRUD + membership + invites + project links.
 * Owns ProjectsModule + RegistriesModule + CryptoModule + KeysModule as
 * nested modules (projects, external package registries and provider
 * keys/tokens live under orgs).
 * Imports DbModule only (UsersService comes from the global UsersModule —
 * no import needed, no cycle). WorkspacePathService is provided directly
 * (stateless). Re-exports ProjectsModule + RegistriesModule + CryptoModule
 * + KeysModule so existing consumers keep working.
 */
@Module({
  imports: [DbModule, ProjectsModule, RegistriesModule, CryptoModule, KeysModule],
  controllers: [OrganizationsController, OrgProjectsController],
  providers: [OrganizationsService, WorkspacePathService],
  exports: [OrganizationsService, ProjectsModule, RegistriesModule, CryptoModule, KeysModule],
})
export class OrganizationsModule {}
