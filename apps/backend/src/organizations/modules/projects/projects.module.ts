import { Module, forwardRef } from "@nestjs/common";
import { DbModule } from "../../../common/db/db.module";
import { WorkspacePathService } from "../../../common/storage/workspace-path.service";
import { ProjectsController } from "./projects.controller";
import { ProjectsService } from "./projects.service";
import { ChatsModule } from "./modules/chats/chats.module";
import { ProjectFilesModule } from "./modules/files/project-files.module";
import { GithubModule } from "./modules/github/github.module";
import { SessionsModule } from "./modules/sessions/sessions.module";
import { OrganizationsModule } from "../../../organizations/organizations.module";

/**
 * ProjectsModule — nested in OrganizationsModule (never registered in
 * AppModule directly). Module-in-module composition: imports ChatsModule +
 * SessionsModule + ProjectFilesModule + GithubModule and re-exports
 * GithubLinkService (owned by GithubModule). Cascades: project delete
 * removes chats/sessions via the nested services (see ProjectsController
 * remove note + services). GithubModule adds GET /api/v1/projects/github
 * /repos (GitHub App installation token, in-memory only). DbModule wires
 * the strict-Postgres ProjectsService (503 when PG is down).
 * WorkspacePathService is provided directly (not via WorkspacesModule) to
 * avoid a module cycle; the service is stateless so a second instance is
 * safe. OrgProjectsController lives on OrganizationsModule (same folder
 * as the controller file) — not duplicated here.
 */
@Module({
  imports: [
    DbModule,
    forwardRef(() => ChatsModule),
    forwardRef(() => SessionsModule),
    forwardRef(() => GithubModule),
    forwardRef(() => OrganizationsModule),
    ProjectFilesModule,
  ],
  controllers: [ProjectsController],
  providers: [ProjectsService, WorkspacePathService],
  exports: [ProjectsService, GithubModule, ChatsModule, SessionsModule],
})
export class ProjectsModule {}
