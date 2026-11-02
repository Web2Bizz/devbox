import { Module } from '@nestjs/common';
import { OrganizationsModule } from '../../../../../organizations/organizations.module';
import { OpencodeModule } from '../opencode/opencode.module';
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
 * HealthModule). The project directory jail rides
 * ProjectAccessService.resolveProjectDirectory.
 */
@Module({
  imports: [OpencodeModule, OrganizationsModule],
  controllers: [SessionsController],
  providers: [SessionsService],
})
export class SessionsModule {}
