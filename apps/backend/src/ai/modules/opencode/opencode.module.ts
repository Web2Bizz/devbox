import { Global, Module } from '@nestjs/common';
import { ServeAuthModule } from './modules/auth/auth.module';
import { BillingModule } from './modules/billing/billing.module';
import { OpencodeKeysController } from '../../../common/keys/keys.controller';
import { CryptoModule } from '../../../common/crypto/crypto.module';
import { KeysModule } from '../../../common/keys/keys.module';
import { OpencodeSdkClient } from './opencode-sdk-client';
import { OpencodeController } from './opencode.controller';
import { OpencodeService } from './opencode.service';
import { OrganizationsModule } from '../../../organizations/organizations.module';
import { WorkspacePathService } from '../../../common/storage/workspace-path.service';

/**
 * Global opencode module (mirrors CommonModule) — OpencodeService is
 * injectable in any provider (SessionsService, HealthController, …) without
 * explicit imports. HealthModule still imports it explicitly to
 * document the dependency.
 *
 * OpencodeSdkClient wraps the pinned @opencode-ai/sdk (transport via
 * ExternalClient timeout/retry); OpencodeController mirrors the upstream
 * opencode OpenAPI under VERSION_NEUTRAL /api/opencode/* so the frontend
 * uses the same sdk against the backend with no new contracts.
 *
 * Decomposed into modules/* submodules (each with its own Nest module):
 * billing (BillingService, live usage), auth (ServeAuthService
 * real-user gate: non-uuid mock → 401 before any upstream call +
 * serveBasicAuthHeader, server Basic from OPENCODE_PASSWORD).
 * Provider keys/tokens (crypto envelope + keys store + /api/v1/key +
 * /api/v1/usage controller) live in common (crypto + keys modules); orgs no
 * longer own provider credentials. Root providers: OpencodeService (single
 * owner of OPENCODE_* config + fetch) + OpencodeSdkClient (pinned
 * @opencode-ai/sdk instance). The per-user DB Bearer is
 * gone from the serve path: no stored key → no 404 anymore; without
 * OPENCODE_PASSWORD the upstream 401 is the honest signal.
 *
 * JwtAuthGuard comes from the global auth module, ExternalClient/AppLogger
 * from the global CommonModule.
 *
 * OrganizationsModule is imported for the C4 project gate
 * (assertProjectAccessById — no cycle, orgs imports only DbModule).
 * WorkspacePathService is provided directly (stateless, same pattern as
 * ProjectsModule) for the C4 project directory jail.
 */
@Global()
@Module({
  imports: [BillingModule, ServeAuthModule, OrganizationsModule, CryptoModule, KeysModule],
  controllers: [OpencodeController, OpencodeKeysController],
  providers: [OpencodeService, OpencodeSdkClient, WorkspacePathService],
  exports: [BillingModule, ServeAuthModule, OpencodeService, OpencodeSdkClient],
})
export class OpencodeModule {}
