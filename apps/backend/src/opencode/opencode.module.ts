import { Global, Module } from '@nestjs/common';
import { OpencodeService } from './opencode.service.js';
import { OpencodeSdkClient } from './opencode-client.js';
import { OpencodeController } from './opencode.controller.js';

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
 */
@Global()
@Module({
  controllers: [OpencodeController],
  providers: [OpencodeService, OpencodeSdkClient],
  exports: [OpencodeService, OpencodeSdkClient],
})
export class OpencodeModule {}
