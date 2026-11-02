import { Global, Module } from '@nestjs/common';
import { AppLogger } from './logger';
import { ExternalClient } from './external/external-client';
import { DbService } from './db/db.service';
import { CryptoService } from './crypto/crypto.service';
import { OpencodeKeysService } from './keys/opencode-keys.service';
import { HealthRegistry } from './health/health-registry';

/**
 * The single Common scope module (CODE_OF_CONDUCT §3): common/ is a shared
 * layer, not a domain — one @Global() module, no `*.module.ts` in subfolders.
 *
 * Providers (injectable anywhere without explicit imports):
 * - AppLogger — structured logger (`new AppLogger('Context')` for non-DI).
 * - ExternalClient — outbound fetch + retry + attempt logging.
 * - DbService — strict Postgres (drizzle + pg); injects ConfigService from
 *   the global ConfigModule (AppModule), so no import is needed here.
 * - CryptoService — AES-256-GCM envelope with versioned KEK rotation.
 * - OpencodeKeysService — per-user OpenCode key store (ciphertext only).
 * - HealthRegistry — probe registry for HealthController (health/ stays
 *   dependency-free: probes register themselves from their own modules).
 */
@Global()
@Module({
  providers: [
    AppLogger,
    ExternalClient,
    DbService,
    CryptoService,
    OpencodeKeysService,
    HealthRegistry,
  ],
  exports: [
    AppLogger,
    ExternalClient,
    DbService,
    CryptoService,
    OpencodeKeysService,
    HealthRegistry,
  ],
})
export class CommonModule {}
