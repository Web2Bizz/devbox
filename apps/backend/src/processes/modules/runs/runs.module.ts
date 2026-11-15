import { Module } from '@nestjs/common';
import { WorkspacePathService } from '@common/storage/workspace-path.service';
import { OrganizationsModule } from '../../../organizations/organizations.module';
import { RunEventSource } from './run-event-source';
import { RunsController } from './runs.controller';
import { RunsRepository } from './runs.repository';
import { RunsService } from './runs.service';

/**
 * Domain runs module — /api/v1/runs* (agent-harness prototype API minimum:
 * create + read one + SSE journal stream).
 *
 * OrganizationsModule is imported explicitly to document the C4 dependency
 * (reaching ProjectAccessService transitively via OrganizationsModule →
 * ProjectsModule → ProjectAccessModule, same convention as SessionsModule).
 * DbService comes from the global CommonModule; WorkspacePathService is
 * provided directly here instead of being re-exported by the organizations
 * domain — the same stateless "provided directly" pattern as
 * ProjectsModule/ProjectAccessModule (a second instance is safe).
 *
 * RunsRepository is exported because the E4 claim loop appends journal rows
 * through the same repository this module writes the run with.
 */
@Module({
  imports: [OrganizationsModule],
  controllers: [RunsController],
  providers: [RunsService, RunsRepository, RunEventSource, WorkspacePathService],
  exports: [RunsService, RunsRepository, RunEventSource],
})
export class RunsModule {}
