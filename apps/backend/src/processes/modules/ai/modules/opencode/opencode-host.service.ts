import { Injectable, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  ExternalServiceError,
  fromStatus,
  fromUnknown,
} from '../../../../../common/external/external-error';
import { AppLogger } from '../../../../../common/logger';

type SdkModule = typeof import('@opencode/sdk');
export type OpencodeHost = Awaited<ReturnType<SdkModule['OpenCode']['create']>>;

/** Host-returned session row (Session.Info). */
export type HostSessionInfo = Awaited<ReturnType<OpencodeHost['sessions']['create']>>;
/** Prompt receipt (Session.Inbox.User). */
export type HostPromptReceipt = Awaited<ReturnType<OpencodeHost['sessions']['prompt']>>;
/** One context message (Session.Message.Info variant). */
export type HostMessage = Awaited<ReturnType<OpencodeHost['sessions']['context']>>[number];
/** Provider inventory answer ({ location, data }). */
export type HostProviderList = Awaited<ReturnType<OpencodeHost['provider']['list']>>;
/** Model inventory answer ({ location, data }). */
export type HostModelList = Awaited<ReturnType<OpencodeHost['model']['list']>>;
/** One event of the embedded host event bus (variant union; consumed structurally). */
export type HostEvent = unknown;

/** Create-session payload accepted by `host.sessions.create`. */
export type HostSessionCreateInput = {
  directory: string;
  title?: string | null;
  parentID?: string | null;
  model?: { id: string; providerID: string; variant?: string } | null;
  agent?: string | null;
};

let sdkPromise: Promise<SdkModule> | null = null;
/** Cached dynamic import of the ESM-only embedded SDK (CJS build safe via .swcrc ignoreDynamic). */
const loadSdk = (): Promise<SdkModule> => (sdkPromise ??= import('@opencode/sdk'));

/**
 * OpencodeHostService — embedded OpenCode V2 host (in-process, no listener,
 * no external runner URL, no Basic auth). One host per backend process.
 *
 * The SDK executes OpenCode's assembled HTTP router in memory; the DB is the
 * source of truth for sessions (migration stages), the SDK database is a
 * restartable mapping/cache. Boot is lazy: onModuleInit starts the host, but a
 * failure is logged and does not abort the whole Nest boot — consumers get a
 * typed 503 until the host is available.
 *
 * Every public helper is typed and maps SDK failures to ExternalServiceError:
 * ClientError("UnexpectedStatus") carries the real status on `cause.status`
 * (400/422 → EXTERNAL_BAD_REQUEST, 404 → EXTERNAL_NOT_FOUND, 5xx/429 through
 * fromStatus), transport failures/timeouts become EXTERNAL_UNAVAILABLE.
 * Logs never carry URLs, secrets or stacks.
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

  /** POST /api/session — create a host session in the given directory. */
  async sessionCreate(input: HostSessionCreateInput): Promise<HostSessionInfo> {
    const host = await this.getHost();
    try {
      return await host.sessions.create({
        location: { directory: input.directory },
        ...(input.title !== undefined && input.title !== null ? { title: input.title } : {}),
        ...(input.parentID !== undefined && input.parentID !== null
          ? { parentID: input.parentID }
          : {}),
        ...(input.model !== undefined && input.model !== null ? { model: input.model } : {}),
        ...(input.agent !== undefined && input.agent !== null ? { agent: input.agent } : {}),
      });
    } catch (err) {
      throw this.failure('sessionCreate', err);
    }
  }

  /** POST /api/session/{id}/prompt — queue the user text, answer the receipt. */
  async sessionPrompt(sessionID: string, text: string): Promise<HostPromptReceipt> {
    const host = await this.getHost();
    try {
      return await host.sessions.prompt({ sessionID, text });
    } catch (err) {
      throw this.failure('sessionPrompt', err);
    }
  }

  /**
   * Session history. The embedded client exposes `session.context` (the
   * message list) and `message.list`; context has no pagination parameters,
   * so callers that need the durable thread read Postgres instead.
   */
  async sessionMessages(sessionID: string): Promise<Array<HostMessage>> {
    const host = await this.getHost();
    try {
      return await host.sessions.context({ sessionID });
    } catch (err) {
      throw this.failure('sessionMessages', err);
    }
  }

  /** POST /api/session/{id}/interrupt — honest { interrupted }. */
  async sessionInterrupt(sessionID: string): Promise<{ interrupted: boolean }> {
    const host = await this.getHost();
    try {
      return await host.sessions.interrupt({ sessionID });
    } catch (err) {
      throw this.failure('sessionInterrupt', err);
    }
  }

  /** DELETE /api/session/{id} — best-effort host cleanup (no domain route). */
  async sessionRemove(sessionID: string): Promise<void> {
    const host = await this.getHost();
    try {
      await host.sessions.remove({ sessionID });
    } catch (err) {
      throw this.failure('sessionRemove', err);
    }
  }

  /**
   * One jailed shell command in `directory` (SandboxProvider pattern: an
   * ephemeral in-process SDK session pinned to the directory, then
   * `sessions.shell({ sessionID, command })`). The session is always removed
   * afterwards (best-effort) so no orphan host session leaks per command.
   * Failures map through `failure()` (EXTERNAL_* envelope, no secrets).
   */
  async sessionShell(directory: string, command: string): Promise<unknown> {
    const host = await this.getHost();
    let sessionID: string | null = null;
    try {
      const session = await host.sessions.create({
        location: { directory },
        title: 'shell',
      });
      sessionID = session.id;
      try {
        return await host.sessions.shell({ sessionID, command });
      } finally {
        await host.sessions.remove({ sessionID }).catch(() => undefined);
      }
    } catch (err) {
      if (sessionID === null && err instanceof ExternalServiceError) throw err;
      throw this.failure('sessionShell', err);
    }
  }

  /** GET /api/provider in the gated jail. */
  async providerList(directory: string): Promise<HostProviderList> {
    const host = await this.getHost();
    try {
      return await host.provider.list({ location: { directory } });
    } catch (err) {
      throw this.failure('sessionProviders', err);
    }
  }

  /** GET /api/model in the gated jail. */
  async modelList(directory: string): Promise<HostModelList> {
    const host = await this.getHost();
    try {
      return await host.model.list({ location: { directory } });
    } catch (err) {
      throw this.failure('sessionModels', err);
    }
  }

  /** In-process event bus subscription; cancelling the signal stops it. */
  async subscribeEvents(signal?: AbortSignal): Promise<AsyncIterable<HostEvent>> {
    const host = await this.getHost();
    // The SDK exposes two shapes depending on the entry point (owner wrapper
    // vs generated client): `subscribe(input?, requestOptions?)` and
    // `subscribe(options?)` where options carries the signal. Passing the
    // signal in BOTH slots keeps cancellation working for either runtime
    // without probing function.length at call time.
    const subscribe = host.events.subscribe.bind(host.events) as unknown as (
      input?: { signal?: AbortSignal },
      requestOptions?: { signal?: AbortSignal },
    ) => AsyncIterable<HostEvent>;
    try {
      return subscribe(
        signal === undefined ? undefined : { signal },
        signal === undefined ? undefined : { signal },
      );
    } catch (err) {
      throw this.failure('sessionEvents', err);
    }
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

  /** Real HTTP-like status carried by ClientError("UnexpectedStatus") on cause. */
  private clientStatus(err: unknown): number | undefined {
    if (typeof err !== 'object' || err === null) return undefined;
    if ((err as { name?: unknown }).name !== 'ClientError') return undefined;
    const cause = (err as { cause?: unknown }).cause;
    if (typeof cause !== 'object' || cause === null) return undefined;
    const status = (cause as { status?: unknown }).status;
    return typeof status === 'number' && Number.isInteger(status) ? status : undefined;
  }

  /**
   * Declared-4xx errors are NOT ClientError: the generated client throws
   * `Object.assign(new Error(message), body)` and sets `name = body._tag`
   * (client chunk `declared()`), so 400/401/404/409/500 arrive as a plain
   * Error whose only status-like signal is the tag. Map the semantic tag,
   * never mask it as a retryable 503.
   */
  private errorTag(err: unknown): string | undefined {
    if (typeof err !== 'object' || err === null) return undefined;
    const tagged = err as { name?: unknown; _tag?: unknown };
    if (typeof tagged._tag === 'string' && tagged._tag.length > 0) return tagged._tag;
    if (
      typeof tagged.name === 'string' &&
      tagged.name.length > 0 &&
      tagged.name !== 'Error' &&
      tagged.name !== 'ClientError'
    ) {
      return tagged.name;
    }
    return undefined;
  }

  private failure(operation: string, err: unknown): ExternalServiceError {
    if (err instanceof ExternalServiceError) return err;
    const status = this.clientStatus(err);
    if (status !== undefined && status >= 400 && status <= 599) {
      return fromStatus('opencode', operation, status, 1, err);
    }
    const tag = this.errorTag(err);
    if (tag !== undefined) {
      if (tag === 'UnauthorizedError') {
        return fromStatus('opencode', operation, 401, 1, err);
      }
      if (tag === 'NotFoundError' || tag.endsWith('NotFoundError')) {
        return fromStatus('opencode', operation, 404, 1, err);
      }
      if (tag === 'ConflictError' || tag === 'SessionBusyError') {
        // Upstream 409 has no dedicated domain code; it is a request-level,
        // non-retryable rejection (NOT an outage with Retry-After).
        return fromStatus('opencode', operation, 400, 1, err);
      }
      if (tag.startsWith('Invalid')) {
        return fromStatus('opencode', operation, 400, 1, err);
      }
      if (tag === 'ServiceUnavailableError') {
        return this.unavailable(operation, err);
      }
      if (tag === 'UnknownError') {
        return fromStatus('opencode', operation, 500, 1, err);
      }
    }
    return fromUnknown('opencode', operation, err);
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
