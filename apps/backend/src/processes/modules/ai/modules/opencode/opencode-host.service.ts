import { Injectable, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ExternalServiceError } from '../../../../../common/external/external-error';
import { AppLogger } from '../../../../../common/logger';

type SdkModule = typeof import('@opencode/sdk');
export type OpencodeHost = Awaited<ReturnType<SdkModule['OpenCode']['create']>>;

let sdkPromise: Promise<SdkModule> | null = null;
/** Cached dynamic import of the ESM-only embedded SDK (CJS build safe via .swcrc ignoreDynamic). */
const loadSdk = (): Promise<SdkModule> => (sdkPromise ??= import('@opencode/sdk'));

/**
 * OpencodeHostService — embedded OpenCode V2 host (in-process, no listener,
 * no OPENCODE_URL, no Basic auth). One host per backend process.
 *
 * The SDK executes OpenCode's assembled HTTP router in memory; the DB is the
 * source of truth for sessions (migration stages), the SDK database is a
 * restartable mapping/cache. Boot is lazy: onModuleInit starts the host, but a
 * failure is logged and does not abort the whole Nest boot — consumers get a
 * typed 503 until the host is available.
 */
@Injectable()
export class OpencodeHostService implements OnModuleInit, OnModuleDestroy {
  private host: OpencodeHost | null = null;
  private starting: Promise<OpencodeHost> | null = null;

  constructor(private readonly logger: AppLogger = new AppLogger(OpencodeHostService.name)) {}

  async onModuleInit(): Promise<void> {
    try {
      await this.getHost();
    } catch (err) {
      this.logger.error('[opencode-host] start failed', '');
      this.logger.debug((err as Error).message, '');
    }
  }

  async onModuleDestroy(): Promise<void> {
    const host = this.host;
    this.host = null;
    this.starting = null;
    if (!host) return;
    try {
      await host.close();
      this.logger.info('[opencode-host] closed', '');
    } catch (err) {
      this.logger.error('[opencode-host] close failed', '');
      this.logger.debug((err as Error).message, '');
    }
  }

  /** Single-flight embedded host; throws a typed 503 when it cannot start. */
  async getHost(): Promise<OpencodeHost> {
    if (this.host) return this.host;
    this.starting ??= this.start();
    try {
      return await this.starting;
    } catch (err) {
      this.starting = null;
      throw this.unavailable('start', err);
    }
  }

  /** Health: embedded host created and alive. */
  isUp(): boolean {
    return this.host !== null;
  }

  private async start(): Promise<OpencodeHost> {
    const startedAt = Date.now();
    // tmpdir DB is a PROTOTYPE cache only: it survives restarts of the process
    // but is disposable. Postgres stays the source of truth for sessions;
    // the embedded SDK database is just a restartable mapping/cache. A real
    // durable path (binding the SDK DB next to REPOS_ROOT / Postgres) is a
    // later migration stage.
    const dbDir = path.join(tmpdir(), 'rush-code-opencode');
    mkdirSync(dbDir, { recursive: true });
    // Config is isolated from ~/.config/opencode: no user MCP servers/plugins
    // are loaded (verified by a spike). Postgres stays the source of truth for
    // sessions; the embedded SDK database is just a restartable cache.
    const configDir = path.join(dbDir, 'config');
    mkdirSync(configDir, { recursive: true });
    const { OpenCode } = await loadSdk();
    const host = await OpenCode.create({
      database: { path: path.join(dbDir, 'sessions.db') },
      config: { directory: configDir, project: false },
      // Never emit attributes/cause: they may carry URLs or secrets.
      log: {
        level: 'warn',
        emit: (entry) => {
          if (entry.level === 'error' || entry.level === 'fatal') {
            this.logger.error(`[opencode-host] ${entry.message}`, '');
          } else if (entry.level === 'warn') {
            this.logger.warn(`[opencode-host] ${entry.message}`, '');
          } else {
            this.logger.debug(`[opencode-host] ${entry.message}`, '');
          }
        },
      },
    });
    this.host = host;
    this.logger.info(`[opencode-host] ready startupMs=${Date.now() - startedAt}`, '');
    return host;
  }

  private unavailable(operation: string, cause: unknown): ExternalServiceError {
    return new ExternalServiceError({
      code: 'EXTERNAL_UNAVAILABLE',
      service: 'opencode',
      operation: `host.${operation}`,
      message: 'сервис временно недоступен, повторите позже',
      isRetryable: true,
      cause,
    });
  }
}
