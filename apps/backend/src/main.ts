import * as dotenv from 'dotenv';
import { expand } from 'dotenv-expand';
import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { type INestApplication } from '@nestjs/common';
import { AppModule } from '@app/app.module';
import { AppLogger, nestLogLevels } from '@common/logger';
import { configureApp, setupSwagger } from '@app/app.setup';
import { validateEnvWithWarnings } from '@common/env/env';

// Expand ${VAR} / ${VAR:-default} from the local .env (single source).
// Never overrides existing process.env (shell/nx with-env wins); never logs secrets.
const dotenvResult: dotenv.DotenvConfigOutput = dotenv.config();
expand(dotenvResult);

/** Shape probed for abort-like failures (DOMException / Node errno 20). */
type AbortLike = {
  name?: string;
  code?: unknown;
  cause?: { name?: string; code?: unknown };
};

function isAbortLike(error: unknown): boolean {
  const value: AbortLike | null = error as AbortLike | null;
  if (!value || typeof value !== 'object') return false;
  return (
    value?.name === 'AbortError' ||
    value?.code === 20 ||
    value?.cause?.name === 'AbortError' ||
    value?.cause?.code === 20
  );
}

// Process-level logger: usable before DI exists; sanitizes + respects
// LOG_LEVEL like every other AppLogger (never raw console.* in runtime code).
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
  if (isAbortLike(reason)) {
    processLogger.debug(`[unhandledRejection] AbortError ignored ${String(reason).slice(0, 200)}`);
    return;
  }
  processLogger.error(
    `[unhandledRejection] ${reason instanceof Error ? reason.message : String(reason).slice(0, 500)}`,
    reason instanceof Error ? (reason.stack ?? undefined) : undefined,
  );
});
process.on('uncaughtException', (error: unknown) => {
  if (isAbortLike(error)) {
    processLogger.debug(`[uncaughtException] AbortError ignored ${String(error).slice(0, 200)}`);
    return;
  }
  throw error;
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
