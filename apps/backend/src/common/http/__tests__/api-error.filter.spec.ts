import "reflect-metadata";
import assert from "node:assert/strict";
import type { ArgumentsHost } from "@nestjs/common";
import {
  BadRequestException,
  ForbiddenException,
  InternalServerErrorException,
  NotFoundException,
  PayloadTooLargeException,
  UnauthorizedException,
} from "@nestjs/common";
import { ExternalServiceError, fromStatus } from "../../external/external-error";
import { ApiErrorFilter } from "../api-error.filter";

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

type Captured = {
  status?: number;
  body?: unknown;
  headers: Record<string, string>;
};

type Hosted = { host: ArgumentsHost; captured: Captured };

function fakeHost(reqInit: Record<string, unknown> = {}): Hosted {
  const captured: Captured = { headers: {} };
  const req: Record<string, unknown> = { headers: {}, ...reqInit };
  const res = {
    headersSent: false,
    destroyed: false,
    writableEnded: false,
    setHeader(name: string, value: string) {
      captured.headers[name] = value;
    },
    status(code: number) {
      captured.status = code;
      return {
        json(body: unknown) {
          captured.body = body;
        },
      };
    },
  };
  const host = {
    switchToHttp: () => ({
      getRequest: () => req,
      getResponse: () => res,
    }),
  } as unknown as ArgumentsHost;
  return { host, captured };
}

function run(exception: unknown, reqInit: Record<string, unknown> = {}): Captured {
  const { host, captured } = fakeHost(reqInit);
  new ApiErrorFilter().catch(exception, host);
  return captured;
}

type Envelope = { code?: string; message?: string; correlationId?: string };

function envelope(captured: Captured): Envelope {
  assert.ok(captured.body, "expected a JSON body");
  return captured.body as Envelope;
}

function abortError(): Error {
  const err = new Error("The operation was aborted");
  err.name = "AbortError";
  return err;
}

describe("ApiErrorFilter", () => {
  it("answers a 400 with the frozen envelope and echoed correlation id", () => {
    const captured = run(new BadRequestException({ code: "bad_request", message: "Field required" }), {
      correlationId: "cid-1",
    });
    assert.equal(captured.status, 400);
    assert.deepEqual(envelope(captured), {
      code: "bad_request",
      message: "Field required",
      correlationId: "cid-1",
    });
    assert.equal(captured.headers["x-correlation-id"], "cid-1");
    assert.deepEqual(Object.keys(envelope(captured)).sort(), [
      "code",
      "correlationId",
      "message",
    ]);
  });

  it("echoes the incoming x-correlation-id header", () => {
    const captured = run(new BadRequestException("bad"), {
      headers: { "x-correlation-id": "header-cid" },
    });
    assert.equal(captured.headers["x-correlation-id"], "header-cid");
    assert.equal(envelope(captured).correlationId, "header-cid");
  });

  it("uses the first value of an array x-correlation-id", () => {
    const captured = run(new BadRequestException("bad"), {
      headers: { "x-correlation-id": ["first-cid", "second-cid"] },
    });
    assert.equal(envelope(captured).correlationId, "first-cid");
  });

  it("prefers req.correlationId over the incoming header", () => {
    const captured = run(new BadRequestException("bad"), {
      correlationId: "req-cid",
      headers: { "x-correlation-id": "header-cid" },
    });
    assert.equal(envelope(captured).correlationId, "req-cid");
  });

  it("generates a UUID correlation id when none is supplied", () => {
    const captured = run(new BadRequestException("bad"));
    const correlationId = envelope(captured).correlationId;
    assert.match(
      correlationId ?? "",
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
    assert.equal(captured.headers["x-correlation-id"], correlationId);
  });

  it("maps a 401 string response to the unauthorized code", () => {
    const captured = run(new UnauthorizedException("Authentication required"));
    assert.equal(captured.status, 401);
    assert.equal(envelope(captured).code, "unauthorized");
    assert.equal(envelope(captured).message, "Authentication required");
  });

  it("maps default 403/404/413 statuses to their codes", () => {
    const forbidden = run(new ForbiddenException());
    assert.equal(forbidden.status, 403);
    assert.equal(envelope(forbidden).code, "forbidden");

    const missing = run(new NotFoundException());
    assert.equal(missing.status, 404);
    assert.equal(envelope(missing).code, "not_found");

    const tooLarge = run(new PayloadTooLargeException());
    assert.equal(tooLarge.status, 413);
    assert.equal(envelope(tooLarge).code, "payload_too_large");
  });

  it("joins an array validation message with '; '", () => {
    const captured = run(
      new BadRequestException({
        code: "bad_request",
        message: ["name required", "email required"],
      }),
    );
    assert.equal(envelope(captured).message, "name required; email required");
  });

  it("never leaks an internal 500 message", () => {
    const captured = run(
      new InternalServerErrorException({
        code: "internal_error",
        message: "db password hunter2",
      }),
    );
    assert.equal(captured.status, 500);
    assert.equal(envelope(captured).code, "internal_error");
    assert.equal(envelope(captured).message, "Unexpected server error");
    assert.ok(!JSON.stringify(captured.body).includes("hunter2"));
  });

  it("answers an unknown error as a generic internal_error", () => {
    const captured = run(new Error("hunter2 at /secret/path"));
    assert.equal(captured.status, 500);
    assert.deepEqual(
      {
        code: envelope(captured).code,
        message: envelope(captured).message,
      },
      { code: "internal_error", message: "Unexpected server error" },
    );
    assert.ok(!JSON.stringify(captured.body).includes("hunter2"));
  });

  it("gives EXTERNAL_UNAVAILABLE a 503 + Retry-After 30", () => {
    const err = new ExternalServiceError({
      code: "EXTERNAL_UNAVAILABLE",
      service: "opencode",
      operation: "dial",
      message: "сервис временно недоступен, повторите позже",
    });
    const captured = run(err, { correlationId: "cid-ext" });
    assert.equal(captured.status, 503);
    assert.equal(captured.headers["Retry-After"], "30");
    assert.equal(envelope(captured).code, "EXTERNAL_UNAVAILABLE");
    assert.equal(envelope(captured).message, err.message);
    assert.equal(envelope(captured).correlationId, "cid-ext");
  });

  it("gives a 429 rate limit a Retry-After 30", () => {
    const captured = run(fromStatus("opencode", "getSession", 429, 2));
    assert.equal(captured.status, 429);
    assert.equal(captured.headers["Retry-After"], "30");
    assert.equal(envelope(captured).code, "EXTERNAL_RATE_LIMITED");
  });

  it("omits Retry-After for EXTERNAL_UNAUTHORIZED", () => {
    const err = new ExternalServiceError({
      code: "EXTERNAL_UNAUTHORIZED",
      service: "opencode",
      operation: "getSession",
      message: "внутренняя авторизация в вышестоящем сервисе не пройдена",
      status: 401,
    });
    const captured = run(err);
    assert.equal(captured.status, 503);
    assert.equal(captured.headers["Retry-After"], undefined);
    assert.equal(envelope(captured).code, "EXTERNAL_UNAUTHORIZED");
  });

  it("omits Retry-After for a non-retryable upstream 404", () => {
    const captured = run(fromStatus("github", "listRepos", 404));
    assert.equal(captured.status, 404);
    assert.equal(captured.headers["Retry-After"], undefined);
    assert.equal(envelope(captured).code, "EXTERNAL_NOT_FOUND");
  });

  it("keeps an external cause off the wire", () => {
    const err = new ExternalServiceError({
      code: "EXTERNAL_UNAVAILABLE",
      service: "opencode",
      operation: "dial",
      message: "сервис временно недоступен, повторите позже",
      cause: new Error("hunter2"),
    });
    const captured = run(err);
    assert.deepEqual(Object.keys(envelope(captured)).sort(), [
      "code",
      "correlationId",
      "message",
    ]);
    assert.ok(!JSON.stringify(captured.body).includes("hunter2"));
  });

  it("writes nothing for an AbortError on a destroyed request", () => {
    const captured = run(abortError(), { destroyed: true });
    assert.equal(captured.status, undefined);
    assert.equal(captured.body, undefined);
    assert.deepEqual(captured.headers, {});
  });

  it("answers an AbortError on a live request with a 500", () => {
    const captured = run(abortError());
    assert.equal(captured.status, 500);
    assert.equal(envelope(captured).code, "internal_error");
    assert.equal(envelope(captured).message, "Unexpected server error");
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
  console.log(`\n${cases.length - failed}/${cases.length} api error filter checks passed`);
  if (failed > 0) process.exitCode = 1;
}

void main().catch((err: unknown) => {
  console.error(`api error filter checks failed to run: ${(err as Error).message}`);
  process.exit(1);
});
