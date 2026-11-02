import { Module, forwardRef } from "@nestjs/common";
import { WorkspacePathService } from "../../../common/storage/workspace-path.service";
import { OrgProjectsController } from "./org-projects.controller";
import { ProjectsController } from "./projects.controller";
import { ProjectsService } from "./projects.service";
import { ChatsModule } from "./modules/chats/chats.module";
import { ProjectFilesModule } from "./modules/files/project-files.module";
import { GithubModule } from "./modules/github/github.module";
import { ProjectAccessModule } from "./modules/project-access/project-access.module";
import { RepositoryModule } from "./modules/repository/repository.module";
import { SessionsModule } from "./modules/sessions/sessions.module";

/**
 * ProjectsModule — nested in the organizations module (never registered in
 * AppModule directly). Module-in-module composition: imports ChatsModule +
 * SessionsModule + ProjectFilesModule + GithubModule + ProjectAccessModule +
 * RepositoryModule and re-exports ProjectsService + ProjectAccessModule +
 * GithubModule/ChatsModule/SessionsModule. Cascades: project delete removes
 * chats/sessions via the nested services (see ProjectsController remove note
 * + services). GithubModule adds GET /api/v1/projects/github/repos (GitHub
 * App installation token, in-memory only). DbService comes from the global
 * CommonModule (503 when PG is down). WorkspacePathService is provided
 * directly (not via WorkspacesModule) to avoid a module cycle; the service
 * is stateless so a second instance is safe.
 *
 * RepositoryModule (nested `modules/repository/`) owns the git-on-disk side
 * of a project: the readonly repo catalog (/repos), the per-user content
 * surface (/workspaces) and the shared git/submodule utils. It is imported
 * here only — never registered in AppModule and never exported outside the
 * projects domain, so both route groups stay mounted through the parent.
 *
 * The C4 project-access gate lives in ProjectAccessModule (nested
 * `modules/project-access/`), owned by this domain — the projects side does
 * NOT import the organizations module anymore (the up-arrow is gone; the
 * gate reads the projects row + OrganizationsGuard directly). External
 * domains keep reaching it transitively via
 * organizations module → ProjectsModule → ProjectAccessModule.
 *
 * Both project surfaces (top-level /projects and the canonical nested
 * /organizations/:id/projects) are served by this module with one
 * controller per entity (CoC §1.1): ProjectsController owns /projects*,
 * OrgProjectsController owns /organizations/:id/projects* (incl. the two
 * 410 attach/detach stubs).
 */
@Module({
  imports: [
    forwardRef(() => ChatsModule),
    forwardRef(() => SessionsModule),
    forwardRef(() => GithubModule),
    ProjectAccessModule,
    ProjectFilesModule,
    RepositoryModule,
  ],
  controllers: [ProjectsController, OrgProjectsController],
  providers: [ProjectsService, WorkspacePathService],
  exports: [
    ProjectsService,
    ProjectAccessModule,
    GithubModule,
    ChatsModule,
    SessionsModule,
  ],
})
export class ProjectsModule {}
