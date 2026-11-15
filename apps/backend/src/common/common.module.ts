import { Global, Module } from '@nestjs/common';
import { AppLogger } from './logger';
import { ExternalClient } from './external/external-client';
import { DbService } from './db/db.service';
import { CryptoService } from './crypto/crypto.service';
import { VaultRepository } from './vault/vault.repository';
import { VaultService } from './vault/vault.service';
import { SessionRunnerService } from './zen/session-runner.service';
import { JevService } from './zen/jev.service';
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
 * - VaultRepository — per-consumer (user|org), per-provider secret store
 *   (ciphertext only, consumer-scoped queries).
 * - VaultService — encrypt/decrypt boundary + round-robin provider key pick.
 * - SessionRunnerService — direct per-user Zen model transport (harness-owned
 *   runner; sessions + agents share it, no domain imports).
  * - JevService — paid System One choice router (ask vs auto; never throws —
  *   Jev failures degrade to heuristic-fallback, the error envelope is
  *   untouched).
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
    VaultRepository,
    VaultService,
    SessionRunnerService,
    JevService,
    HealthRegistry,
  ],
  exports: [
    AppLogger,
    ExternalClient,
    DbService,
    CryptoService,
    VaultRepository,
    VaultService,
    SessionRunnerService,
    JevService,
    HealthRegistry,
  ],
})
export class CommonModule {}
