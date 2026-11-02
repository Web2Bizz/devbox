import { Module, forwardRef } from "@nestjs/common";
import { ProjectsModule } from "../../projects.module";
import { GithubAppService } from "./github-app.service";
import { GithubBindingService } from "./github-binding.service";
import { GithubInstallationsService } from "./github-installations.service";
import { GithubLinkService } from "./github-link.service";
import { GithubController } from "./github.controller";
import { GithubService } from "./github.service";

/**
 * Nested module — imported by ProjectsModule, never registered in AppModule directly.
 * DbService comes from the global CommonModule (503 when PG is down).
 * GithubAppService token cache stays memory-only (tokens never persisted).
 */
@Module({
  imports: [forwardRef(() => ProjectsModule)],
  controllers: [GithubController],
  providers: [GithubAppService, GithubBindingService, GithubInstallationsService, GithubService, GithubLinkService],
  exports: [GithubAppService, GithubBindingService, GithubInstallationsService, GithubService, GithubLinkService],
})
export class GithubModule {}
