import { Global, Module } from '@nestjs/common';
import { OpencodeService } from './opencode.service';
import { OpencodeSdkClient } from './opencode-client';
import { OpencodeController } from './opencode.controller';
import { OpencodeKeysModule } from '../opencode-keys/opencode-keys.module';
import { OrganizationsModule } from '../organizations/organizations.module';
import { WorkspacePathService } from '../workspaces/workspace-path.service';

/**
 * Global opencode module (mirrors CommonModule) — OpencodeService is
 * injectable in any provider (ProxyService, HealthController, …) without
 * explicit imports. HealthModule / ApiModule still import it explicitly to
 * document the dependency.
 *
 * OpencodeSdkClient wraps the pinned @opencode-ai/sdk (transport via
 * ExternalClient timeout/retry); OpencodeController mirrors the upstream
 * opencode OpenAPI under VERSION_NEUTRAL /api/opencode/* so the frontend
 * uses the same sdk against the backend with no new contracts.
 *
 * OpencodeKeysModule is imported for OpencodeAuthService (real-user gate:
 * non-uuid mock → 401 before any upstream call) + serveBasicAuthHeader
 * (server Basic from OPENCODE_PASSWORD) — no cycle (opencode-keys never
 * imports opencode). The per-user DB Bearer is gone from the serve path:
 * no stored key → no 404 anymore; without OPENCODE_PASSWORD the upstream
 * 401 is the honest signal.
 *
 * OrganizationsModule is imported for the C4 project gate
 * (assertProjectAccessById — no cycle, orgs imports only DbModule).
 * WorkspacePathService is provided directly (stateless, same pattern as
 * ProjectsModule) for the C4 project directory jail.
 */
@Global()
@Module({
  imports: [OpencodeKeysModule, OrganizationsModule],
  controllers: [OpencodeController],
  providers: [OpencodeService, OpencodeSdkClient, WorkspacePathService],
  exports: [OpencodeService, OpencodeSdkClient],
})
export class OpencodeModule {}
