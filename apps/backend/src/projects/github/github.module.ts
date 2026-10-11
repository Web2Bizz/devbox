import { Module, forwardRef } from "@nestjs/common";
import { DbModule } from "../../db/db.module.js";
import { ProjectsModule } from "../projects.module.js";
import { GithubAppService } from "./github-app.service.js";
import { GithubInstallationsService } from "./github-installations.service.js";
import { GithubController } from "./github.controller.js";
import { GithubService } from "./github.service.js";

/**
 * Nested module — imported by ProjectsModule, never registered in AppModule directly.
 * DbModule wires the strict-Postgres GithubInstallationsService (503 when PG is down).
 * GithubAppService token cache stays memory-only (tokens never persisted).
 */
@Module({
  imports: [DbModule, forwardRef(() => ProjectsModule)],
  controllers: [GithubController],
  providers: [GithubAppService, GithubInstallationsService, GithubService],
  exports: [GithubAppService, GithubInstallationsService, GithubService],
})
export class GithubModule {}
