import * as dotenv from 'dotenv';
import { expand } from 'dotenv-expand';
import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { type INestApplication } from '@nestjs/common';
import { AppModule } from '@app/app.module';
import { AppLogger, nestLogLevels } from '@common/logger';
import { resolveProcessFate, type ProcessFate } from './common/exceptions/process-error';
import { configureApp, setupSwagger } from '@app/app.setup';
import { validateEnvWithWarnings } from '@common/env/env';

// Expand ${VAR} / ${VAR:-default} from the local .env (single source).
// Never overrides existing process.env (shell/nx with-env wins); never logs secrets.
const dotenvResult: dotenv.DotenvConfigOutput = dotenv.config();
expand(dotenvResult);

// Process-level logger: usable before DI exists; sanitizes + respects
// LOG_LEVEL like every other AppLogger (never raw console.* in runtime code).
// Fate решает ЕДИНСТВЕННЫЙ resolveProcessFate из common/exceptions
// (abort → тихо, pg-transient/db-outage → keep-alive, остальное → fatal).
// NEVER `throw` из этих хендлеров: throw из uncaughtException всегда роняет
// процесс. Дубли предикатов здесь запрещены — вся классификация в exceptions/.
const PROCESS_CONTEXT: string = 'Process';
const processLogger: AppLogger = new AppLogger(PROCESS_CONTEXT);

// SSE downstream disconnect (GET /api/v1/sessions/events) surfaces as
// DOMException AbortError outside Nest context (EventEmitter close →
// upstream.abort() → emitCloseNT) as unhandledRejection — log at debug so
// real opencode timeouts (ExternalClient → EXTERNAL_TIMEOUT, handled via
// upstreamError → 503) stay visible in the retry path and are never
// swallowed here. Only the SSE relay signal abort is expected; anything
// else is logged as error below.
process.on('unhandledRejection', (reason: unknown) => {
  const fate: ProcessFate = resolveProcessFate(reason);
  if (fate.reason === 'abort') {
    processLogger.debug(`[unhandledRejection] AbortError ignored ${String(reason).slice(0, 200)}`);
    return;
  }
  // Transient outage (pg-transient / db-outage) already answered 503 at the
  // request boundary — log and stay up, same as uncaughtException keep-alive.
  // Anything else is fatal: logger.fatal + exit(1) so the supervisor
  // restarts a known-clean process instead of running half-broken.
  if (fate.keepAlive) {
    const text: string = reason instanceof Error ? reason.message : String(reason);
    processLogger.error(
      `[unhandledRejection] ${fate.reason} kept alive (${text.slice(0, 200)})`,
      reason instanceof Error ? (reason.stack ?? undefined) : undefined,
    );
    return;
  }
  const text: string = reason instanceof Error ? reason.message : String(reason);
  processLogger.fatal(
    `[unhandledRejection] fatal (${text.slice(0, 500)})`,
    reason instanceof Error ? (reason.stack ?? undefined) : undefined,
  );
  process.exit(1);
});
process.on('uncaughtException', (error: unknown) => {
  const fate: ProcessFate = resolveProcessFate(error);
  if (fate.reason === 'abort') {
    processLogger.debug(`[uncaughtException] AbortError ignored ${String(error).slice(0, 200)}`);
    return;
  }
  // A dropped pg socket (codeless `Connection terminated unexpectedly`,
  // ECONNRESET/ETIMEDOUT/EPIPE, SQLSTATE 57P01/57P02…) can surface outside
  // any request context (pool 'error' races, in-flight query after a PG
  // restart) — this class is transient by definition, so log it and stay up
  // (the DAL breaker already short-circuits new reads to 503 + Retry-After;
  // the next half-open probe recovers without a restart). An already-mapped
  // db EXTERNAL_UNAVAILABLE escaping to the process level is the same outage
  // surfacing twice (the request itself already answered 503 via
  // ApiErrorFilter) — also kept alive.
  // ONLY these two classes are kept alive — anything else logs fatal and
  // exits(1) so the supervisor restarts a known-clean process.
  if (fate.keepAlive) {
    const text: string = error instanceof Error ? error.message : String(error);
    processLogger.error(
      `[uncaughtException] ${fate.reason} kept alive (${text.slice(0, 200)})`,
      error instanceof Error ? (error.stack ?? undefined) : undefined,
    );
    return;
  }
  const text: string = error instanceof Error ? error.message : String(error);
  processLogger.fatal(
    `[uncaughtException] fatal (${text.slice(0, 500)})`,
    error instanceof Error ? (error.stack ?? undefined) : undefined,
  );
  process.exit(1);
});

async function bootstrap(): Promise<void> {
  const BOOTSTRAP_CONTEXT: string = 'Bootstrap';
  const logger: AppLogger = new AppLogger(BOOTSTRAP_CONTEXT);
  try {
    // validateEnvWithWarnings() runs FIRST: fail-fast on bad ports/URLs (never logs secrets).
    // WARNs (fallbacks, deprecated/unknown keys) are scrubbed by AppLogger like everything else.
    const { env, warnings } = validateEnvWithWarnings();
    const PORT: number = env.backendPort;
    for (const warning of warnings) {
      // ERROR-level notices (e.g. unconfigured REPOS_ROOT storage outage) must
      // surface at error level even though boot continues (health unchanged);
      // plain WARN fallbacks stay at warn. Never carries secrets.
      if (warning.includes("[env] ERROR")) logger.error(warning);
      else logger.warn(warning);
    }

    const app: INestApplication = await NestFactory.create(AppModule, {
      cors: false,
      // Framework logs respect LOG_LEVEL too.
      logger: nestLogLevels(env.logLevel),
    });

    // Global 'api' prefix + URI versioning (/api/v1/*, legacy /api/*),
    // CORS, CorrelationInterceptor, ApiErrorFilter — shared with e2e.
    configureApp(app);

    // Swagger: /swagger + /swagger/v1 serve the v1 doc, /swagger/v2 is a stub.
    setupSwagger(app);

    await app.listen(PORT);
    // Port only — no secrets, no URLs with credentials.
    logger.log(`listening on :${PORT}`);
  } catch (error: unknown) {
    // Single-line boot failure: AppLogger.fatal() sanitizes (URL credentials
    // masked, live secrets scrubbed) like every other log; stack is dropped
    // (message only, truncated) so [env]-errors don't double-spam via
    // process.on('unhandledRejection'). exit(1) lets the supervisor (nx/compose
    // restart policy) restart cleanly instead of hanging with no open port.
    const text: string = error instanceof Error ? error.message : String(error);
    logger.fatal(String(text).slice(0, 500));
    process.exit(1);
  }
}

void bootstrap();
