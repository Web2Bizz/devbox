/**
 * exceptions checks — self-contained runner (plain node:assert, no live Postgres).
 *
 * Runs against COMPILED dist:
 *   `bun run build && bun dist/common/exceptions/__tests__/exceptions.spec.js`
 * Also executes under `bun run test` (dist/*.spec.js).
 *
 * Covers the global error layer (no per-module duplicates):
 * - resolveProcessFate: abort/pg-transient/db-outage → keep-alive, else fatal;
 * - isRetryableError reuses the single predicate (no second copy);
 * - ApiErrorFilter global scope: typed AppError + ValidationError → 400
 *   without Retry-After.
 * DB-mapped cases (mapDbError, pg-transient predicate, DbUnavailable filter)
 * live in db/exceptions/__tests__/db-exceptions.spec.ts next to the moved files.
 */
import assert from "node:assert/strict";
import type { ArgumentsHost } from "@nestjs/common";
import { isRetryableError } from "@common/external/retry";
import { ApiErrorFilter } from "@common/http/api-error.filter";
import { isDbOutageError } from "@common/exceptions/app-error";
import { DbUnavailableError } from "@common/db/exceptions/db-unavailable.error";
import { StorageUnavailableError } from "@common/exceptions/storage-unavailable.error";
import { ValidationError } from "@common/exceptions/validation.error";
import { resolveProcessFate } from "@common/exceptions/process-error";

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

describe("exceptions", () => {
  it("isRetryableError reuses the single predicate (no duplicate walk)", () => {
    assert.equal(isRetryableError(pgError("ECONNRESET")), true);
    assert.equal(
      isRetryableError(drizzleWrapped(new Error("socket hang up"))),
      true,
    );
    assert.equal(isRetryableError({ status: 503 }), true);
    assert.equal(isRetryableError({ status: 400 }), false);
  });

  it("resolveProcessFate keeps transient/db-outage alive, else fatal", () => {
    assert.deepEqual(resolveProcessFate(pgError("ECONNRESET")), {
      keepAlive: true,
      reason: "pg-transient",
    });
    assert.deepEqual(
      resolveProcessFate(new DbUnavailableError("checkDb")),
      { keepAlive: true, reason: "db-outage" },
    );
    assert.deepEqual(
      resolveProcessFate(new StorageUnavailableError("repos.list")),
      { keepAlive: true, reason: "db-outage" },
    );
    const abort: Error = Object.assign(new Error("aborted"), {
      name: "AbortError",
    });
    assert.deepEqual(resolveProcessFate(abort), {
      keepAlive: true,
      reason: "abort",
    });
    assert.deepEqual(
      resolveProcessFate(new ValidationError("op", "bad")),
      { keepAlive: false, reason: "fatal" },
    );
    assert.deepEqual(resolveProcessFate(new Error("boom")), {
      keepAlive: false,
      reason: "fatal",
    });
  });

  it("isDbOutageError matches any service=db AppError", () => {
    assert.equal(isDbOutageError(new DbUnavailableError("op")), true);
    assert.equal(
      isDbOutageError(new StorageUnavailableError("op")),
      false,
    );
  });

  it("filter answers ValidationError with 400 and no Retry-After", () => {
    const captured: Captured = runFilter(
      new ValidationError("create", "name required"),
    );
    assert.equal(captured.status, 400);
    assert.equal(captured.headers["Retry-After"], undefined);
    assert.equal((captured.body as { code?: string }).code, "VALIDATION_FAILED");
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
  console.log(`\n${cases.length - failed}/${cases.length} exceptions checks passed`);
  if (failed > 0) process.exitCode = 1;
}

void main().catch((err: unknown) => {
  console.error(`exceptions checks failed to run: ${(err as Error).message}`);
  process.exit(1);
});
