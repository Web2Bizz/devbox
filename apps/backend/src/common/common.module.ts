import { Global, Module } from '@nestjs/common';
import { AppLogger } from './app-logger.service';
import { ExternalClient } from './external/external-client';

/**
 * Global logger module — AppLogger is injectable in any provider
 * (ProxyService, DbService, …) without explicit imports.
 * Non-DI contexts (main.ts bootstrap, ApiErrorFilter via `new`) use
 * `new AppLogger('Context')` directly.
 * ExternalClient (outbound fetch + retry + attempt logging) is global too —
 * inject it anywhere; it falls back to env defaults when unconfigured.
 */
@Global()
@Module({
  providers: [AppLogger, ExternalClient],
  exports: [AppLogger, ExternalClient],
})
export class CommonModule {}
