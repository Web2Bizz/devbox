import {
  RequestMethod,
  VersioningType,
  type INestApplication,
} from '@nestjs/common';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { json } from 'express';
import { ApiErrorFilter } from './common/api-error.filter';
import { CorrelationInterceptor } from './common/correlation.interceptor';
import { validateEnv } from './env';
import { DEFAULT_API_VERSION } from './api/version';

/**
 * Shared Nest application wiring — used by main.ts AND the versioning e2e
 * suite, so boot-time routing is identical in prod and tests.
 *
 * Resulting URL scheme:
 * - /api/v1/*  — URI-versioned v1 (global prefix 'api' + version prefix 'v').
 *   Controllers must NOT repeat the 'api' segment (no setGlobalPrefix('api')
 *   + @Controller('api') stacking — that would produce /api/api/*).
 * - /api/*     — removed (unversioned aliases gone → 404 not_found envelope).
 * - /health    — VERSION_NEUTRAL, excluded from the global prefix (root path).
 * - /api/v2/*  — unbound → 404 { code: 'not_found', … } envelope.
 */
export function configureApp(app: INestApplication): void {
  // validateEnv() never logs secrets; CORS origins come from the same source.
  const CORS_ORIGINS = validateEnv(process.env).corsOrigins;

  app.use(json({
    limit: '1mb',
    // Captures exact raw bytes for HMAC verification of the GitHub webhook
    // (X-Hub-Signature-256). Never logged; only the webhook route reads it.
    verify: (req: unknown, _res: unknown, buf: Buffer) => {
      if (typeof req === 'object' && req !== null) {
        (req as { rawBody?: Buffer }).rawBody = buf;
      }
    },
  }));

  // NOTE: `exclude` matches the route path *without* the version segment
  // (Nest truncates /v{N} before comparing), so 'health' keeps /health for
  // both neutral and (hypothetical) versioned registrations.
  app.setGlobalPrefix('api', {
    exclude: [{ path: 'health', method: RequestMethod.ALL }],
  });
  app.enableVersioning({
    type: VersioningType.URI,
    defaultVersion: DEFAULT_API_VERSION,
  });

  // CORS — same semantics as the node:http build:
  // allowlist match or '*' → echo origin; no origin (curl/smoke) → allow;
  // unknown origin → answer with the first allowlisted origin (browser blocks).
  app.enableCors({
    origin: (
      origin: string | undefined,
      callback: (err: Error | null, allow?: boolean | string) => void,
    ) => {
      if (!origin) {
        callback(null, true);
        return;
      }
      if (CORS_ORIGINS.includes('*') || CORS_ORIGINS.includes(origin)) {
        callback(null, origin);
        return;
      }
      callback(null, CORS_ORIGINS[0] ?? '*');
    },
    methods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: [
      'content-type',
      'x-correlation-id',
      'api-version',
      'x-user-id',
      'authorization',
    ],
    exposedHeaders: ['x-correlation-id', 'api-version'],
    // true: the auth refresh httpOnly cookie (devbox-refresh) + marker must
    // travel cross-origin (frontend :3001 → backend :3100). Origins stay
    // allowlisted above — no wildcard with credentials.
    credentials: true,
  });

  app.useGlobalInterceptors(new CorrelationInterceptor());
  app.useGlobalFilters(new ApiErrorFilter());
}

type SwaggerSetupOptions = Parameters<typeof SwaggerModule.setup>[3];

/**
 * Versioned Swagger surface:
 * - GET /swagger/v1 (+ /swagger/v1.json, /openapi.v1.yaml) — canonical v1 doc.
 * - GET /swagger      (+ /swagger.json,  /openapi.yaml)    — SAME v1 document
 *   (back-compat: pre-existing bookmarks/tooling keep working on v1).
 * - GET /swagger/v2 (+ /swagger/v2.json) — reserved stub, empty paths:
 *   v2 has no endpoints yet; /api/v2/* returns 404.
 *
 * SwaggerModule.setup() does NOT apply the global 'api' prefix by default
 * (useGlobalPrefix opt-in), so these paths stay exactly as documented.
 */
export function setupSwagger(app: INestApplication): void {
  const v1Config = new DocumentBuilder()
    .setTitle('Devbox opencode proxy API')
    .setDescription(
      'Thin proxy layer between frontend clients and the live opencode server. ' +
        'Backend (NestJS 12) forwards /api/v1/* to OPENCODE_URL with ' +
        'REQUEST_TIMEOUT_MS timeout; unreachable upstream answers 503 ' +
        'EXTERNAL_UNAVAILABLE with Retry-After (no mock fallbacks). ' +
        'Error envelope is always { code, message, correlationId }. ' +
        'Unversioned /api/* aliases were removed (now 404 not_found) — use /api/v1/*. ' +
        'Canonical UI: /swagger/v1. /swagger serves the same v1 document.',
    )
    .setVersion('0.1.0')
    // Примеры в примерах (docs-only, не рантайм-дефолты): серверы ниже — лишь
    // подсказки Swagger UI, на поведение/роутинг не влияют (AGENTS.md: примеры
    // localhost в спеках — ок, рантайм-дефолты без WARN/throw — нарушение).
    .addServer('http://localhost:3000', 'backend local')
    .addServer('http://localhost:8080', 'frontend via compose (proxied browser → backend)')
    .build();
  const v1Document = SwaggerModule.createDocument(app, v1Config);

  const v1Ui: SwaggerSetupOptions = {
    jsonDocumentUrl: '/swagger/v1.json',
    yamlDocumentUrl: '/openapi.v1.yaml',
    // Surfaced into swagger-ui-init.js (`url = options.swaggerUrl || url`)
    // so the UI bundle explicitly references the JSON endpoint.
    swaggerUrl: '/swagger/v1.json',
  } as SwaggerSetupOptions;
  SwaggerModule.setup('/swagger/v1', app, v1Document, v1Ui);

  const legacyUi: SwaggerSetupOptions = {
    jsonDocumentUrl: '/swagger.json',
    yamlDocumentUrl: '/openapi.yaml',
    swaggerUrl: '/swagger.json',
  } as SwaggerSetupOptions;
  SwaggerModule.setup('/swagger', app, v1Document, legacyUi);

  const v2Config = new DocumentBuilder()
    .setTitle('Devbox opencode proxy API (v2 — reserved)')
    .setDescription(
      'v2 is reserved for future use and intentionally exposes NO endpoints yet. ' +
        'Every /api/v2/* request returns 404 { code: "not_found", … }. ' +
        'Use /api/v1/* (canonical UI: /swagger/v1).',
    )
    .setVersion('2.0.0-stub')
    .addServer('http://localhost:3000', 'backend local')
    .build();
  const v2Document = SwaggerModule.createDocument(app, v2Config);
  // Stub: drop the auto-scanned v1/legacy routes — v2 binds nothing.
  (v2Document as unknown as { paths: Record<string, unknown> }).paths = {};
  const v2Ui: SwaggerSetupOptions = {
    jsonDocumentUrl: '/swagger/v2.json',
    swaggerUrl: '/swagger/v2.json',
  } as SwaggerSetupOptions;
  SwaggerModule.setup('/swagger/v2', app, v2Document, v2Ui);
}
