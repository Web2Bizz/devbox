import { Module } from '@nestjs/common';
import { OrganizationsModule } from '../../../../../organizations/organizations.module';
import { OpencodeModule } from '../opencode/opencode.module';
import { WorkspacePathService } from '../../../../../common/storage/workspace-path.service';
import { SessionsController } from './sessions.controller';
import { SessionsService } from './sessions.service';

/**
 * Domain sessions module — /api/sessions* (the product contract replacing
 * the deprecated /api/opencode/* mirror; see SessionsService for the
 * translation and gate composition).
 *
 * OpencodeModule (OpencodeService + OpencodeSdkClient + ServeAuthService —
 * the real-user gate the raw prompt path asserts below the sdk) and
 * OrganizationsModule (C4 gate, reaching ProjectAccessService transitively
 * via OrganizationsModule → ProjectsModule → ProjectAccessModule) are
 * imported explicitly to document the dependencies (same convention as
 * HealthModule); WorkspacePathService is provided directly
 * (stateless, same pattern as OpencodeModule/ProjectsModule).
 */
@Module({
  imports: [OpencodeModule, OrganizationsModule],
  controllers: [SessionsController],
  providers: [SessionsService, WorkspacePathService],
})
export class SessionsModule {}
