import { Module } from "@nestjs/common";
import { DbModule } from "../common/db/db.module";
import { WorkspacePathService } from "../common/storage/workspace-path.service";
import { ProjectsModule } from "./modules/projects/projects.module";
import { RegistriesModule } from "./modules/registries/registries.module";
import { OrgProjectsController } from "./org-projects.controller";
import { OrganizationsController } from "./organizations.controller";
import { OrganizationsService } from "./organizations.service";

/**
 * OrganizationsModule — org CRUD + membership + invites + project links.
 * Owns ProjectsModule + RegistriesModule as nested modules (projects and
 * external package registries live under orgs; CryptoModule + KeysModule
 * moved to common and are imported by their consumers directly).
 * Imports DbModule only (UsersService comes from the global UsersModule —
 * no import needed, no cycle). WorkspacePathService is provided directly
 * (stateless). Re-exports ProjectsModule + RegistriesModule so existing
 * consumers keep working.
 */
@Module({
  imports: [DbModule, ProjectsModule, RegistriesModule],
  controllers: [OrganizationsController, OrgProjectsController],
  providers: [OrganizationsService, WorkspacePathService],
  exports: [OrganizationsService, ProjectsModule, RegistriesModule],
})
export class OrganizationsModule {}
