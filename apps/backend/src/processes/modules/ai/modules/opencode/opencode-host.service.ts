import { Injectable, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  ExternalServiceError,
  fromStatus,
  fromUnknown,
} from '@common/external/external-error';
import { AppLogger } from '@common/logger';

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

/** Both SDK `subscribe(input?, requestOptions?)` call shapes, unified. */
type HostSubscribe = (
  input?: { signal?: AbortSignal },
  requestOptions?: { signal?: AbortSignal },
) => AsyncIterable<HostEvent>;

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
const loadSdk: () => Promise<SdkModule> = (): Promise<SdkModule> =>
  (sdkPromise ??= import('@opencode/sdk'));

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
    } catch (error) {
      this.logger.error('[opencode-host] start failed', '');
      this.logger.debug((error as Error).message, '');
    }
  }

  async onModuleDestroy(): Promise<void> {
    const host: OpencodeHost | null = this.host;
    this.host = null;
    this.starting = null;
    if (!host) return;
    try {
      await host.close();
      this.logger.info('[opencode-host] closed', '');
    } catch (error) {
      this.logger.error('[opencode-host] close failed', '');
      this.logger.debug((error as Error).message, '');
    }
  }

  /** Single-flight embedded host; throws a typed 503 when it cannot start. */
  async getHost(): Promise<OpencodeHost> {
    if (this.host) return this.host;
    this.starting ??= this.start();
    try {
      return await this.starting;
    } catch (error) {
      this.starting = null;
      throw this.unavailable('start', error);
    }
  }

  /** Health: embedded host created and alive. */
  isUp(): boolean {
    return this.host !== null;
  }

  /** POST /api/session — create a host session in the given directory. */
  async sessionCreate(input: HostSessionCreateInput): Promise<HostSessionInfo> {
    const host: OpencodeHost = await this.getHost();
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
    } catch (error) {
      throw this.failure('sessionCreate', error);
    }
  }

  /** POST /api/session/{id}/prompt — queue the user text, answer the receipt. */
  async sessionPrompt(sessionID: string, text: string): Promise<HostPromptReceipt> {
    const host: OpencodeHost = await this.getHost();
    try {
      return await host.sessions.prompt({ sessionID, text });
    } catch (error) {
      throw this.failure('sessionPrompt', error);
    }
  }

  /**
   * Session history. The embedded client exposes `session.context` (the
   * message list) and `message.list`; context has no pagination parameters,
   * so callers that need the durable thread read Postgres instead.
   */
  async sessionMessages(sessionID: string): Promise<Array<HostMessage>> {
    const host: OpencodeHost = await this.getHost();
    try {
      return await host.sessions.context({ sessionID });
    } catch (error) {
      throw this.failure('sessionMessages', error);
    }
  }

  /** POST /api/session/{id}/interrupt — honest { interrupted }. */
  async sessionInterrupt(sessionID: string): Promise<{ interrupted: boolean }> {
    const host: OpencodeHost = await this.getHost();
    try {
      return await host.sessions.interrupt({ sessionID });
    } catch (error) {
      throw this.failure('sessionInterrupt', error);
    }
  }

  /** DELETE /api/session/{id} — best-effort host cleanup (no domain route). */
  async sessionRemove(sessionID: string): Promise<void> {
    const host: OpencodeHost = await this.getHost();
    try {
      await host.sessions.remove({ sessionID });
    } catch (error) {
      throw this.failure('sessionRemove', error);
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
    const host: OpencodeHost = await this.getHost();
    let sessionID: string | null = null;
    try {
      const session: HostSessionInfo = await host.sessions.create({
        location: { directory },
        title: 'shell',
      });
      sessionID = session.id;
      try {
        return await host.sessions.shell({ sessionID, command });
      } finally {
        await host.sessions.remove({ sessionID }).catch(() => undefined);
      }
    } catch (error) {
      if (sessionID === null && error instanceof ExternalServiceError) throw error;
      throw this.failure('sessionShell', error);
    }
  }

  /** GET /api/provider in the gated jail. */
  async providerList(directory: string): Promise<HostProviderList> {
    const host: OpencodeHost = await this.getHost();
    try {
      return await host.provider.list({ location: { directory } });
    } catch (error) {
      throw this.failure('sessionProviders', error);
    }
  }

  /** GET /api/model in the gated jail. */
  async modelList(directory: string): Promise<HostModelList> {
    const host: OpencodeHost = await this.getHost();
    try {
      return await host.model.list({ location: { directory } });
    } catch (error) {
      throw this.failure('sessionModels', error);
    }
  }

  /** In-process event bus subscription; cancelling the signal stops it.
   *
   * Live-only detail (reasoning `session.reasoning.*`, tool lifecycle
   * `session.tool.*`, text `session.text.*`, step/execution markers) rides
   * this bus untouched: no filtering here, no persist here. Project scoping
   * lives in SessionStreamService (filterFrame) and durable-vs-live
   * separation in AssistantRecorderService (recordHostEvent) — this host only
   * relays.
   */
  async subscribeEvents(signal?: AbortSignal): Promise<AsyncIterable<HostEvent>> {
    const host: OpencodeHost = await this.getHost();
    // The SDK exposes two shapes depending on the entry point (owner wrapper
    // vs generated client): `subscribe(input?, requestOptions?)` and
    // `subscribe(options?)` where options carries the signal. Passing the
    // signal in BOTH slots keeps cancellation working for either runtime
    // without probing function.length at call time.
    const subscribe: HostSubscribe = host.events.subscribe.bind(
      host.events,
    ) as unknown as HostSubscribe;
    try {
      return subscribe(
        signal === undefined ? undefined : { signal },
        signal === undefined ? undefined : { signal },
      );
    } catch (error) {
      throw this.failure('sessionEvents', error);
    }
  }

  private async start(): Promise<OpencodeHost> {
    const startedAt: number = Date.now();
    // tmpdir DB is a PROTOTYPE cache only: it survives restarts of the process
    // but is disposable. Postgres stays the source of truth for sessions;
    // the embedded SDK database is just a restartable mapping/cache. A real
    // durable path (binding the SDK DB next to REPOS_ROOT / Postgres) is a
    // later migration stage.
    const databaseDirectory: string = path.join(tmpdir(), 'rush-code-opencode');
    mkdirSync(databaseDirectory, { recursive: true });
    // Config is isolated from ~/.config/opencode: no user MCP servers/plugins
    // are loaded (verified by a spike). Postgres stays the source of truth for
    // sessions; the embedded SDK database is just a restartable cache.
    const configurationDirectory: string = path.join(databaseDirectory, 'config');
    mkdirSync(configurationDirectory, { recursive: true });
    const { OpenCode }: SdkModule = await loadSdk();
    const host: OpencodeHost = await OpenCode.create({
      database: { path: path.join(databaseDirectory, 'sessions.db') },
      config: { directory: configurationDirectory, project: false },
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
  private clientStatus(error: unknown): number | undefined {
    if (typeof error !== 'object' || error === null) return undefined;
    if ((error as { name?: unknown }).name !== 'ClientError') return undefined;
    const cause: unknown = (error as { cause?: unknown }).cause;
    if (typeof cause !== 'object' || cause === null) return undefined;
    const status: unknown = (cause as { status?: unknown }).status;
    return typeof status === 'number' && Number.isInteger(status) ? status : undefined;
  }

  /**
   * Declared-4xx errors are NOT ClientError: the generated client throws
   * `Object.assign(new Error(message), body)` and sets `name = body._tag`
   * (client chunk `declared()`), so 400/401/404/409/500 arrive as a plain
   * Error whose only status-like signal is the tag. Map the semantic tag,
   * never mask it as a retryable 503.
   */
  private errorTag(error: unknown): string | undefined {
    if (typeof error !== 'object' || error === null) return undefined;
    const tagged: { name?: unknown; _tag?: unknown } = error as {
      name?: unknown;
      _tag?: unknown;
    };
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

  private failure(operation: string, error: unknown): ExternalServiceError {
    if (error instanceof ExternalServiceError) return error;
    const status: number | undefined = this.clientStatus(error);
    if (status !== undefined && status >= 400 && status <= 599) {
      return fromStatus('opencode', operation, status, 1, error);
    }
    const tag: string | undefined = this.errorTag(error);
    if (tag !== undefined) {
      if (tag === 'UnauthorizedError') {
        return fromStatus('opencode', operation, 401, 1, error);
      }
      if (tag === 'NotFoundError' || tag.endsWith('NotFoundError')) {
        return fromStatus('opencode', operation, 404, 1, error);
      }
      if (tag === 'ConflictError' || tag === 'SessionBusyError') {
        // Upstream 409 has no dedicated domain code; it is a request-level,
        // non-retryable rejection (NOT an outage with Retry-After).
        return fromStatus('opencode', operation, 400, 1, error);
      }
      if (tag.startsWith('Invalid')) {
        return fromStatus('opencode', operation, 400, 1, error);
      }
      if (tag === 'ServiceUnavailableError') {
        return this.unavailable(operation, error);
      }
      if (tag === 'UnknownError') {
        return fromStatus('opencode', operation, 500, 1, error);
      }
    }
    return fromUnknown('opencode', operation, error);
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
