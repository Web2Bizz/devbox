import * as dotenv from 'dotenv';
import { expand } from 'dotenv-expand';

// Expand ${VAR} / ${VAR:-default} from the local .env (single source).
// Never overrides existing process.env (shell/nx with-env wins); never logs secrets.
const dotenvResult = dotenv.config();
expand(dotenvResult);

import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { AppLogger, nestLogLevels } from './common/app-logger.service';
import { configureApp, setupSwagger } from './app.setup';
import { validateEnvWithWarnings } from './env';

function isAbortLike(e: unknown): boolean {
  const v = e as {
    name?: string;
    code?: unknown;
    cause?: { name?: string; code?: unknown };
  } | null;
  if (!v || typeof v !== 'object') return false;
  return (
    v?.name === 'AbortError' ||
    v?.code === 20 ||
    v?.cause?.name === 'AbortError' ||
    v?.cause?.code === 20
  );
}

// Process-level logger: usable before DI exists; sanitizes + respects
// LOG_LEVEL like every other AppLogger (never raw console.* in runtime code).
const processLogger = new AppLogger('Process');

// SSE downstream disconnect (GET /api/opencode/global/event) surfaces as
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
process.on('uncaughtException', (err: unknown) => {
  if (isAbortLike(err)) {
    processLogger.debug(`[uncaughtException] AbortError ignored ${String(err).slice(0, 200)}`);
    return;
  }
  throw err;
});

async function bootstrap(): Promise<void> {
  const logger = new AppLogger('Bootstrap');
  try {
    // validateEnvWithWarnings() runs FIRST: fail-fast on bad ports/URLs (never logs secrets).
    // WARNs (fallbacks, deprecated/unknown keys) are scrubbed by AppLogger like everything else.
    const { env, warnings } = validateEnvWithWarnings();
    const PORT = env.backendPort;
    for (const w of warnings) {
      // ERROR-level notices (e.g. unconfigured REPOS_ROOT storage outage) must
      // surface at error level even though boot continues (health unchanged);
      // plain WARN fallbacks stay at warn. Never carries secrets.
      if (w.includes("[env] ERROR")) logger.error(w);
      else logger.warn(w);
    }

    const app = await NestFactory.create(AppModule, {
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
  } catch (err: unknown) {
    // Single-line boot failure: AppLogger.fatal() sanitizes (URL credentials
    // masked, live secrets scrubbed) like every other log; stack is dropped
    // (message only, truncated) so [env]-errors don't double-spam via
    // process.on('unhandledRejection'). exit(1) lets the supervisor (nx/compose
    // restart policy) restart cleanly instead of hanging with no open port.
    const text = err instanceof Error ? err.message : String(err);
    logger.fatal(String(text).slice(0, 500));
    process.exit(1);
  }
}

void bootstrap();
