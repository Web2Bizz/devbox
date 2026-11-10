import { Injectable } from "@nestjs/common";
import type { GithubLinkStatusDto } from "../../projects.dto";
import { ProjectsService, type Project } from "../../projects.service";

/**
 * GithubLinkService — read-only GitHub link status, lives inside
 * GithubModule. Never stores tokens/credentials (only owner/repo/branch
 * text on the project row). Format-only checks; no outbound network.
 * No path resolver use: disk homes resolve inside ProjectsService
 * (orgs/<orgUuid>/projects/<id>/content).
 *
 * Write paths (link/unlink) were removed with their routes: PATCH
 * githubOwner/githubRepo/githubBranch is the only way to change the link.
 */
@Injectable()
export class GithubLinkService {
  constructor(private readonly projects: ProjectsService) {}

  async status(projectId: string, correlationId?: string): Promise<GithubLinkStatusDto> {
    const project: Project = await this.projects.getOrThrow(projectId, correlationId);
    const linked: boolean = Boolean(project.githubOwner && project.githubRepo);
    return {
      linked,
      owner: project.githubOwner,
      repo: project.githubRepo,
      branch: project.githubBranch,
      url: project.githubUrl,
    };
  }
}
