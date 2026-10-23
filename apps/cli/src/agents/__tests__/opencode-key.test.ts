// opencode key/client tests: missing-key fail-fast, scrub, /agent parse.
// Run: bun test --isolate src (apps/cli).

import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  chatOpencode,
  getOpencodeKey,
  hasOpencodeKey,
  OPENCODE_API_BASE_URL,
  OPENCODE_CHAT_PATH,
  OPENCODE_DEFAULT_MODEL,
  resolveChatEndpoint,
  scrubOpencodeText,
} from "../opencode.js";
import { parseLine } from "../../prompt/repl.js";

describe("opencode key", () => {
  const NO_KEY_ENV = { XDG_DATA_HOME: "/tmp/devbox-cli-no-key-test" } as NodeJS.ProcessEnv;

  test("missing key fails fast with env/auth hint", () => {
    expect(() => getOpencodeKey(NO_KEY_ENV)).toThrow("missing OPENCODE_API_KEY");
    expect(() => getOpencodeKey(NO_KEY_ENV)).toThrow("auth.json");
    expect(hasOpencodeKey(NO_KEY_ENV)).toBe(false);
    expect(hasOpencodeKey({ ...NO_KEY_ENV, OPENCODE_API_KEY: "k" })).toBe(true);
  });

  test("env key wins over missing auth.json", () => {
    expect(getOpencodeKey({ ...NO_KEY_ENV, OPENCODE_API_KEY: "  live-key " })).toBe("live-key");
  });

  test("scrub hides Bearer and URL creds (no secret in output)", () => {
    const dirty = "Authorization: Bearer super-secret-123 and postgres://u:p@ss@host/db";
    const clean = scrubOpencodeText(dirty);
    expect(clean).toContain("Bearer [redacted]");
    expect(clean).not.toContain("super-secret-123");
    expect(clean).toContain("[redacted]@");
  });

  test("chat error cause is scrubbed and capped", async () => {
    const failingFetch = (async () => {
      throw new TypeError("fetch failed for Bearer abcdef");
    }) as unknown as typeof fetch;
    await expect(
      chatOpencode("hello", {
        env: { ...NO_KEY_ENV, OPENCODE_API_KEY: "k" } as NodeJS.ProcessEnv,
        fetchImpl: failingFetch,
        timeoutMs: 1000,
      }),
    ).rejects.toThrow("[redacted]");
  });

  test("chat echo returns reply in box-ready text", async () => {
    const echoFetch = (async () =>
      new Response(JSON.stringify({ text: "echo: hello world" }), { status: 200 }),
    ) as unknown as typeof fetch;
    const reply = await chatOpencode("hello world", {
      env: { ...NO_KEY_ENV, OPENCODE_API_KEY: "k" } as NodeJS.ProcessEnv,
      fetchImpl: echoFetch,
    });
    expect(reply).toContain("hello world");
    expect(reply).not.toContain("Bearer");
  });

  test("parse /agent keeps name/prompt/--apply", () => {
    expect(parseLine("/agent ask hello")).toEqual({
      kind: "agent-run",
      agent: "ask",
      prompt: "hello",
      apply: false,
    });
    expect(parseLine("/agent build do it --apply")).toEqual({
      kind: "agent-run",
      agent: "build",
      prompt: "do it",
      apply: true,
    });
  });
});

describe("opencode cloud base url", () => {
  const NO_KEY_ENV = { XDG_DATA_HOME: "/tmp/devbox-cli-no-key-test" } as NodeJS.ProcessEnv;

  test("base URL is hard-coded to the real Cloud host (not the catch-all)", () => {
    expect(OPENCODE_API_BASE_URL.startsWith("https://")).toBe(true);
    expect(OPENCODE_API_BASE_URL).toBe("https://opencode.ai");
    expect(OPENCODE_API_BASE_URL).not.toContain("api.opencode.ai");
  });

  test("chat endpoint is built from base via new URL (never relative)", () => {
    expect(resolveChatEndpoint(NO_KEY_ENV)).toBe(
      new URL(OPENCODE_CHAT_PATH, OPENCODE_API_BASE_URL).toString(),
    );
    expect(OPENCODE_CHAT_PATH).toBe("/inference/systemone/v1/systemone");
    expect(resolveChatEndpoint(NO_KEY_ENV)).toBe(
      "https://opencode.ai/inference/systemone/v1/systemone",
    );
  });

  test("fetch goes to the hard-coded base chat endpoint", async () => {
    let seenUrl = "";
    const captureFetch = (async (url: string | URL | Request) => {
      seenUrl = String(url);
      return new Response(JSON.stringify({ text: "ok" }), { status: 200 });
    }) as unknown as typeof fetch;
    await chatOpencode("hello", {
      env: { ...NO_KEY_ENV, OPENCODE_API_KEY: "k" } as NodeJS.ProcessEnv,
      fetchImpl: captureFetch,
    });
    expect(seenUrl).toBe(`${OPENCODE_API_BASE_URL}${OPENCODE_CHAT_PATH}`);
  });

  test("OPENCODE_API_BASE_URL env overrides just the base", async () => {
    expect(
      resolveChatEndpoint({
        ...NO_KEY_ENV,
        OPENCODE_API_BASE_URL: "https://stage.example.com",
      } as NodeJS.ProcessEnv),
    ).toBe("https://stage.example.com/inference/systemone/v1/systemone");
    let seenUrl = "";
    const captureFetch = (async (url: string | URL | Request) => {
      seenUrl = String(url);
      return new Response(JSON.stringify({ text: "ok" }), { status: 200 });
    }) as unknown as typeof fetch;
    await chatOpencode("hello", {
      env: {
        ...NO_KEY_ENV,
        OPENCODE_API_KEY: "k",
        OPENCODE_API_BASE_URL: "https://stage.example.com ",
      } as NodeJS.ProcessEnv,
      fetchImpl: captureFetch,
    });
    expect(seenUrl).toBe("https://stage.example.com/inference/systemone/v1/systemone");
  });

  test("fetch sends the v2 systemone contract (model/state/questions + Bearer)", async () => {
    let seenUrl = "";
    let seenInit: RequestInit = {};
    const captureFetch = (async (url: string | URL | Request, init?: RequestInit) => {
      seenUrl = String(url);
      seenInit = init ?? {};
      return new Response(JSON.stringify({ text: "ok" }), { status: 200 });
    }) as unknown as typeof fetch;
    await chatOpencode("hello", {
      env: { ...NO_KEY_ENV, OPENCODE_API_KEY: "k" } as NodeJS.ProcessEnv,
      fetchImpl: captureFetch,
    });
    expect(seenUrl).toBe(`${OPENCODE_API_BASE_URL}${OPENCODE_CHAT_PATH}`);
    const headers = seenInit.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer k");
    const body = JSON.parse(String(seenInit.body)) as Record<string, unknown>;
    expect(body.model).toBe(OPENCODE_DEFAULT_MODEL);
    expect(body.state).toBe("hello");
    expect(body.questions).toMatchObject({
      reply: { type: "choice", instructions: expect.any(String), criteria: expect.anything() },
    });
  });

  test("systemone answers shape resolves to choice text", async () => {
    const answersFetch = (async () =>
      new Response(
        JSON.stringify({ answers: { reply: { choice: "v2 answer", confidence: 0.9 } } }),
        { status: 200 },
      )) as unknown as typeof fetch;
    const reply = await chatOpencode("hello", {
      env: { ...NO_KEY_ENV, OPENCODE_API_KEY: "k" } as NodeJS.ProcessEnv,
      fetchImpl: answersFetch,
    });
    expect(reply).toBe("v2 answer");
  });

  test("401 JSON is a scrubbed failure (no 404 HTML expected)", async () => {
    const deniedFetch = (async () =>
      new Response(JSON.stringify({ type: "error", error: { type: "AuthError" } }), {
        status: 401,
      })) as unknown as typeof fetch;
    await expect(
      chatOpencode("hello", {
        env: { ...NO_KEY_ENV, OPENCODE_API_KEY: "k" } as NodeJS.ProcessEnv,
        fetchImpl: deniedFetch,
      }),
    ).rejects.toThrow("status=401");
  });

  test("env key wins over auth.json file key (order: env → file)", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "devbox-cli-auth-"));
    fs.mkdirSync(path.join(dir, "opencode"), { recursive: true });
    fs.writeFileSync(
      path.join(dir, "opencode", "auth.json"),
      JSON.stringify({ "opencode-go": { key: "  file-key\n" }, opencode: { key: "other" } }),
    );
    const fileEnv = { XDG_DATA_HOME: dir } as NodeJS.ProcessEnv;
    expect(getOpencodeKey(fileEnv)).toBe("file-key");
    expect(getOpencodeKey({ ...fileEnv, OPENCODE_API_KEY: " env-key " })).toBe("env-key");
    expect(getOpencodeKey({ ...fileEnv, JEV_API_KEY: "jev-key" })).toBe("jev-key");
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
