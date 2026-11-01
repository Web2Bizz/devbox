import { Global, Module } from '@nestjs/common';
import { DbModule } from './db/db.module';
import { AppLogger } from './logger';
import { ExternalClient } from './external/external-client';

/**
 * Global logger module — AppLogger is injectable in any provider
 * (SessionsService, DbService, …) without explicit imports.
 * Non-DI contexts (main.ts bootstrap, ApiErrorFilter via `new`) use
 * `new AppLogger('Context')` directly.
 * ExternalClient (outbound fetch + retry + attempt logging) is global too —
 * inject it anywhere; it falls back to env defaults when unconfigured.
 * Owns DbModule (strict Postgres) as a nested module and re-exports it so
 * existing consumers keep working without import changes.
 */
@Global()
@Module({
  imports: [DbModule],
  providers: [AppLogger, ExternalClient],
  exports: [AppLogger, ExternalClient, DbModule],
})
export class CommonModule {}
