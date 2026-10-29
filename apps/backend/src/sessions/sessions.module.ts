import { Module } from '@nestjs/common';
import { OrganizationsModule } from '../organizations/organizations.module';
import { OpencodeModule } from '../opencode/opencode.module';
import { WorkspacePathService } from '../workspaces/workspace-path.service';
import { SessionsController } from './sessions.controller';
import { SessionsService } from './sessions.service';

/**
 * Domain sessions module — /api/sessions* (the product contract replacing
 * the deprecated /api/opencode/* mirror; see SessionsService for the
 * translation and gate composition).
 *
 * OpencodeModule (OpencodeService + OpencodeSdkClient) and
 * OrganizationsModule (C4 gate) are imported explicitly to document the
 * dependency (same convention as HealthModule/ApiModule);
 * WorkspacePathService is provided directly (stateless, same pattern as
 * OpencodeModule/ProjectsModule).
 */
@Module({
  imports: [OpencodeModule, OrganizationsModule],
  controllers: [SessionsController],
  providers: [SessionsService, WorkspacePathService],
})
export class SessionsModule {}
