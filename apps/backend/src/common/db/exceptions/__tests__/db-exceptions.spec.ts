/**
 * db/exceptions checks — self-contained runner (plain node:assert, no live Postgres).
 *
 * Runs against COMPILED dist:
 *   `bun run build && bun dist/common/db/exceptions/__tests__/db-exceptions.spec.js`
 * Also executes under `bun run test` (dist/*.spec.js).
 *
 * Covers the DB error layer (moved from common/exceptions, no behavior change):
 * - mapDbError normalizes ANY pg/drizzle failure to DbUnavailableError
 *   (not only transient) — 503 EXTERNAL_UNAVAILABLE, retryable, instanceof
 *   ExternalServiceError + AppError (back-compat wire + type guards);
 * - single pg-transient predicate (codes/SQLSTATE/cause-unwrap);
 * - ApiErrorFilter global scope: typed DbUnavailableError + raw pg
 *   transient → 503 + Retry-After 30.
 */
import assert from "node:assert/strict";
import type { ArgumentsHost } from "@nestjs/common";
import { ExternalServiceError } from "@common/external/external-error";
import { ApiErrorFilter } from "@common/http/api-error.filter";
import { isAppError } from "@common/exceptions/app-error";
import { isPgTransientConnectionError } from "@common/db/exceptions/pg-transient";
import {
  DbUnavailableError,
  mapDbError,
} from "@common/db/exceptions/db-unavailable.error";

type Case = { name: string; run: () => Promise<void> | void };

const cases: Array<Case> = [];
let currentSuite = "";

function describe(name: string, fn: () => void): void {
  currentSuite = name;
  fn();
  currentSuite = "";
}

function it(name: string, run: () => Promise<void> | void): void {
  cases.push({ name: currentSuite ? `${currentSuite} :: ${name}` : name, run });
}

function pgError(code: string, message?: string): Error {
  return Object.assign(new Error(message ?? `read ${code}`), { code });
}

function drizzleWrapped(inner: unknown): Error {
  return Object.assign(new Error("Failed query: SELECT 1"), {
    cause: inner,
  });
}

type Captured = {
  status?: number;
  body?: unknown;
  headers: Record<string, string>;
};

function runFilter(exception: unknown): Captured {
  const captured: Captured = { headers: {} };
  const req: Record<string, unknown> = { headers: {} };
  const res = {
    setHeader(name: string, value: string): void {
      captured.headers[name] = value;
    },
    status(code: number): { json: (body: unknown) => void } {
      captured.status = code;
      return {
        json(body: unknown): void {
          captured.body = body;
        },
      };
    },
  };
  const host: ArgumentsHost = {
    switchToHttp: (): unknown => ({
      getRequest: (): unknown => req,
      getResponse: (): unknown => res,
    }),
  } as unknown as ArgumentsHost;
  new ApiErrorFilter().catch(exception, host);
  return captured;
}

describe("db-exceptions", () => {
  it("mapDbError wraps a raw pg ECONNRESET into DbUnavailableError 503", () => {
    const mapped: DbUnavailableError | ExternalServiceError = mapDbError(
      "users.findById",
      pgError("ECONNRESET"),
    );
    assert.ok(mapped instanceof DbUnavailableError);
    assert.ok(mapped instanceof ExternalServiceError);
    assert.ok(isAppError(mapped));
    assert.equal(mapped.code, "EXTERNAL_UNAVAILABLE");
    assert.equal(mapped.service, "db");
    assert.equal(mapped.httpStatus, 503);
    assert.equal(mapped.isRetryable, true);
  });

  it("mapDbError unwraps the drizzle cause chain (codeless terminated)", () => {
    const inner: Error = new Error("Connection terminated unexpectedly");
    const mapped: DbUnavailableError | ExternalServiceError = mapDbError(
      "sessions.list",
      drizzleWrapped(inner),
    );
    assert.ok(mapped instanceof DbUnavailableError);
    assert.equal(mapped.code, "EXTERNAL_UNAVAILABLE");
  });

  it("mapDbError handles non-transient pg errors too (all errors, 23505)", () => {
    const mapped: DbUnavailableError | ExternalServiceError = mapDbError(
      "users.create",
      pgError("23505", "duplicate key value"),
    );
    assert.ok(mapped instanceof DbUnavailableError);
    assert.equal(mapped.httpStatus, 503);
    assert.equal(isPgTransientConnectionError(pgError("23505")), false);
  });

  it("passes through an already-typed db ExternalServiceError", () => {
    const original: ExternalServiceError = new ExternalServiceError({
      code: "EXTERNAL_UNAVAILABLE",
      service: "db",
      operation: "organizations.list",
      message: "сервис временно недоступен, повторите позже",
    });
    assert.equal(mapDbError("organizations.list", original), original);
  });

  it("single pg-transient predicate matches codes and cause chain", () => {
    assert.equal(isPgTransientConnectionError(pgError("ECONNRESET")), true);
    assert.equal(
      isPgTransientConnectionError(drizzleWrapped(pgError("57P01"))),
      true,
    );
    assert.equal(
      isPgTransientConnectionError(
        new Error("Connection terminated unexpectedly"),
      ),
      true,
    );
    assert.equal(isPgTransientConnectionError(pgError("23505")), false);
    assert.equal(isPgTransientConnectionError(new Error("boom")), false);
  });

  it("filter answers DbUnavailableError with 503 + Retry-After 30", () => {
    const captured: Captured = runFilter(new DbUnavailableError("users.list"));
    assert.equal(captured.status, 503);
    assert.equal(captured.headers["Retry-After"], "30");
    assert.equal((captured.body as { code?: string }).code, "EXTERNAL_UNAVAILABLE");
  });

  it("filter answers a raw pg transient even when the module forgot to map", () => {
    const captured: Captured = runFilter(
      drizzleWrapped(new Error("Connection terminated unexpectedly")),
    );
    assert.equal(captured.status, 503);
    assert.equal(captured.headers["Retry-After"], "30");
    assert.equal((captured.body as { code?: string }).code, "EXTERNAL_UNAVAILABLE");
  });
});

async function main(): Promise<void> {
  let failed = 0;
  for (const c of cases) {
    try {
      await c.run();
      console.log(`ok   - ${c.name}`);
    } catch (err) {
      failed += 1;
      console.error(`FAIL - ${c.name}: ${(err as Error).message}`);
    }
  }
  console.log(`\n${cases.length - failed}/${cases.length} db-exceptions checks passed`);
  if (failed > 0) process.exitCode = 1;
}

void main().catch((err: unknown) => {
  console.error(`db-exceptions checks failed to run: ${(err as Error).message}`);
  process.exit(1);
});
