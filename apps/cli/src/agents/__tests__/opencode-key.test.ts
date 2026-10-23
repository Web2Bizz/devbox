// opencode key/client tests: missing-key fail-fast, scrub, /agent parse.
// Run: bun test --isolate src (apps/cli).

import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  chatLocal,
  chatOpencode,
  getOpencodeKey,
  hasOpencodeKey,
  OPENCODE_API_BASE_URL,
  OPENCODE_CHAT_PATH,
  OPENCODE_DEFAULT_MODEL,
  OPENCODE_LOCAL_URL,
  resetLocalSessionForTests,
  resolveChatEndpoint,
  resolveLocalBaseUrl,
  scrubOpencodeText,
} from "../opencode.js";
import {
  CLEAR_SEQUENCE,
  PROMPT_LABEL,
  clearScreen,
  parseLine,
  shouldClearForRepl,
} from "../../prompt/repl.js";
import { errorBox, greeting } from "../../ui/box.js";

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
      new Response(JSON.stringify({ text: "echo: hello world" }), { status: 200 })
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

  test("answers.reply.choice returns the value, never the key name", async () => {
    const replyFetch = (async () =>
      new Response(JSON.stringify({ answers: { reply: { choice: "hello world" } } }), {
        status: 200,
      })) as unknown as typeof fetch;
    const reply = await chatOpencode("hello", {
      env: { ...NO_KEY_ENV, OPENCODE_API_KEY: "k" } as NodeJS.ProcessEnv,
      fetchImpl: replyFetch,
    });
    expect(reply).toBe("hello world");
    expect(reply).not.toBe("reply");
    expect(reply).not.toBe("answer");
  });

  test("answers.answer.choice shape also resolves to its value", async () => {
    const answerFetch = (async () =>
      new Response(JSON.stringify({ answers: { answer: { choice: "hello world" } } }), {
        status: 200,
      })) as unknown as typeof fetch;
    const reply = await chatOpencode("hello", {
      env: { ...NO_KEY_ENV, OPENCODE_API_KEY: "k" } as NodeJS.ProcessEnv,
      fetchImpl: answerFetch,
    });
    expect(reply).toBe("hello world");
    expect(reply).not.toBe("answer");
  });

  test("answers string fallback returns the value (not the key)", async () => {
    const stringFetch = (async () =>
      new Response(JSON.stringify({ answers: { reply: "hello world string" } }), {
        status: 200,
      })) as unknown as typeof fetch;
    const reply = await chatOpencode("hello", {
      env: { ...NO_KEY_ENV, OPENCODE_API_KEY: "k" } as NodeJS.ProcessEnv,
      fetchImpl: stringFetch,
    });
    expect(reply).toBe("hello world string");
  });

  test("answers choice is scrubbed and capped", async () => {
    const dirtyFetch = (async () =>
      new Response(
        JSON.stringify({ answers: { reply: { choice: "hi Bearer super-secret-123" } } }),
        { status: 200 },
      )) as unknown as typeof fetch;
    const reply = await chatOpencode("hello", {
      env: { ...NO_KEY_ENV, OPENCODE_API_KEY: "k" } as NodeJS.ProcessEnv,
      fetchImpl: dirtyFetch,
    });
    expect(reply).toContain("Bearer [redacted]");
    expect(reply).not.toContain("super-secret-123");
  });

  test("choices/delta shapes join to text", async () => {
    const choicesFetch = (async () =>
      new Response(
        JSON.stringify({
          choices: [{ message: { content: "part one" } }, { delta: { content: "part two" } }],
        }),
        { status: 200 },
      )) as unknown as typeof fetch;
    const reply = await chatOpencode("hello", {
      env: { ...NO_KEY_ENV, OPENCODE_API_KEY: "k" } as NodeJS.ProcessEnv,
      fetchImpl: choicesFetch,
    });
    expect(reply).toContain("part one");
    expect(reply).toContain("part two");
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

describe("opencode local serve chat (Go subscription, free text)", () => {
  const NO_KEY_ENV = { XDG_DATA_HOME: "/tmp/devbox-cli-no-key-test" } as NodeJS.ProcessEnv;

  // Local serve mock: POST /session → {id}, POST /session/<id>/message → {parts}.
  function localFetch(seen: { urls: string[]; auth?: string; bodies: string[] }) {
    return (async (url: string | URL | Request, init?: RequestInit) => {
      const u = String(url);
      seen.urls.push(u);
      const headers = (init?.headers ?? {}) as Record<string, string>;
      if (headers.Authorization) seen.auth = headers.Authorization;
      seen.bodies.push(String(init?.body ?? ""));
      if (u.endsWith("/session")) {
        return new Response(JSON.stringify({ id: "ses_local_1" }), { status: 200 });
      }
      return new Response(JSON.stringify({ parts: [{ type: "text", text: "hello world" }] }), {
        status: 200,
      });
    }) as unknown as typeof fetch;
  }

  test("creates session once, posts message parts, shows text (not 'answer')", async () => {
    resetLocalSessionForTests();
    const seen = { urls: [] as string[], auth: undefined as string | undefined, bodies: [] as string[] };
    const reply = await chatLocal("hello world", {
      env: NO_KEY_ENV,
      fetchImpl: localFetch(seen),
    });
    expect(seen.urls[0]).toBe(`${OPENCODE_LOCAL_URL}/session`);
    expect(seen.urls[1]).toBe(`${OPENCODE_LOCAL_URL}/session/ses_local_1/message`);
    const msgBody = JSON.parse(seen.bodies[1]) as Record<string, unknown>;
    expect(msgBody).toMatchObject({ parts: [{ type: "text", text: "hello world" }] });
    expect(reply).toBe("hello world");
    expect(reply).not.toBe("answer");
    // Second call reuses the cached session (no new POST /session).
    const reply2 = await chatLocal("again", {
      env: NO_KEY_ENV,
      fetchImpl: localFetch(seen),
    });
    expect(reply2).toBe("hello world");
    expect(seen.urls.filter((u) => u.endsWith("/session"))).toHaveLength(1);
    expect(seen.auth).toBeUndefined();
    resetLocalSessionForTests();
  });

  test("OPENCODE_TOKEN=x sends Authorization Bearer x on /session and /message", async () => {
    resetLocalSessionForTests();
    const auths: Array<string | undefined> = [];
    const tokenFetch = (async (url: string | URL | Request, init?: RequestInit) => {
      const headers = (init?.headers ?? {}) as Record<string, string>;
      auths.push(headers.Authorization);
      if (String(url).endsWith("/session")) {
        return new Response(JSON.stringify({ id: "ses_token_1" }), { status: 200 });
      }
      return new Response(JSON.stringify({ parts: [{ type: "text", text: "ok" }] }), {
        status: 200,
      });
    }) as unknown as typeof fetch;
    const reply = await chatLocal("hello", {
      env: { ...NO_KEY_ENV, OPENCODE_TOKEN: "x" } as NodeJS.ProcessEnv,
      fetchImpl: tokenFetch,
    });
    expect(reply).toBe("ok");
    expect(auths).toHaveLength(2);
    expect(auths[0]).toBe("Bearer x");
    expect(auths[1]).toBe("Bearer x");
    resetLocalSessionForTests();
  });

  test("empty OPENCODE_TOKEN sends no Authorization header", async () => {
    resetLocalSessionForTests();
    const auths: Array<string | undefined> = [];
    const noAuthFetch = (async (url: string | URL | Request, init?: RequestInit) => {
      const headers = (init?.headers ?? {}) as Record<string, string>;
      auths.push(headers.Authorization);
      if (String(url).endsWith("/session")) {
        return new Response(JSON.stringify({ id: "ses_noauth_1" }), { status: 200 });
      }
      return new Response(JSON.stringify({ parts: [{ type: "text", text: "ok" }] }), {
        status: 200,
      });
    }) as unknown as typeof fetch;
    await chatLocal("hello", {
      env: { ...NO_KEY_ENV, OPENCODE_TOKEN: "  " } as NodeJS.ProcessEnv,
      fetchImpl: noAuthFetch,
    });
    expect(auths).toHaveLength(2);
    expect(auths[0]).toBeUndefined();
    expect(auths[1]).toBeUndefined();
    resetLocalSessionForTests();
  });

  test("local base default + OPENCODE_URL/OPENCODE_SERVER_URL override", () => {
    expect(OPENCODE_LOCAL_URL).toBe("http://127.0.0.1:4096");
    expect(resolveLocalBaseUrl(NO_KEY_ENV)).toBe("http://127.0.0.1:4096");
    expect(
      resolveLocalBaseUrl({ ...NO_KEY_ENV, OPENCODE_URL: "http://localhost:4096/" }),
    ).toBe("http://localhost:4096");
    expect(
      resolveLocalBaseUrl({ ...NO_KEY_ENV, OPENCODE_SERVER_URL: "http://0.0.0.0:4096" }),
    ).toBe("http://0.0.0.0:4096");
  });

  test("parts[] text joined, scrubbed and capped; empty → shape mismatch", async () => {
    resetLocalSessionForTests();
    const multiFetch = (async (url: string | URL | Request) => {
      if (String(url).endsWith("/session")) {
        return new Response(JSON.stringify({ id: "ses_multi" }), { status: 200 });
      }
      return new Response(
        JSON.stringify({ parts: [{ type: "text", text: "part one" }, { type: "text", text: "Bearer abc" }] }),
        { status: 200 },
      );
    }) as unknown as typeof fetch;
    const reply = await chatLocal("hi", { env: NO_KEY_ENV, fetchImpl: multiFetch });
    expect(reply).toContain("part one");
    expect(reply).toContain("Bearer [redacted]");
    expect(reply).not.toContain("abc");
    resetLocalSessionForTests();
    const emptyFetch = (async (url: string | URL | Request) => {
      if (String(url).endsWith("/session")) {
        return new Response(JSON.stringify({ id: "ses_empty" }), { status: 200 });
      }
      return new Response(JSON.stringify({ parts: [] }), { status: 200 });
    }) as unknown as typeof fetch;
    await expect(chatLocal("hi", { env: NO_KEY_ENV, fetchImpl: emptyFetch })).rejects.toThrow(
      "empty reply",
    );
    resetLocalSessionForTests();
  });

  test("serve down → unreachable with opencode serve hint (never empty)", async () => {
    resetLocalSessionForTests();
    const downFetch = (async () => {
      throw new TypeError("fetch failed");
    }) as unknown as typeof fetch;
    await expect(
      chatLocal("hi", { env: NO_KEY_ENV, fetchImpl: downFetch, timeoutMs: 1000 }),
    ).rejects.toThrow("opencode serve --port 4096");
    const down503 = (async (url: string | URL | Request) => {
      if (String(url).endsWith("/session")) {
        return new Response("unavailable", { status: 503 });
      }
      return new Response("unavailable", { status: 503 });
    }) as unknown as typeof fetch;
    await expect(chatLocal("hi", { env: NO_KEY_ENV, fetchImpl: down503 })).rejects.toThrow(
      "opencode serve --port 4096",
    );
    resetLocalSessionForTests();
  });
});

describe("repl startup keeps fail-fast errors after clear", () => {
  const NO_KEY_ENV = { XDG_DATA_HOME: "/tmp/devbox-cli-no-key-test" } as NodeJS.ProcessEnv;

  test("start writes clear first, then greeting, prompt stays bottom", () => {
    const writes: string[] = [];
    const write = (s: string): void => void writes.push(s);
    clearScreen(write);
    write(greeting("0.1.0"));
    write(PROMPT_LABEL);
    expect([...(writes[0] as string)].map((c) => c.charCodeAt(0))).toEqual([27, 99]);
    expect(writes[1]).toContain("◆ DEVBOX CLI");
    expect(writes[writes.length - 1]).toBe("prompt > ");
  });

  test("missing-key error surfaces after clear in ✗-box (nothing lost)", () => {
    const writes: string[] = [];
    writes.push(CLEAR_SEQUENCE);
    let message = "";
    try {
      getOpencodeKey(NO_KEY_ENV);
    } catch (err) {
      message = err instanceof Error ? err.message : String(err);
    }
    expect(message).toContain("missing OPENCODE_API_KEY");
    writes.push(errorBox(message, "Set OPENCODE_API_KEY in env or auth.json (see .env.example)."));
    expect(writes[0]).toBe(CLEAR_SEQUENCE);
    expect(writes[1]).toContain("✗");
    expect(writes[1]).toContain("auth.json");
    expect(writes.join("\n")).not.toContain("Bearer super-secret");
  });

  test("non-TTY help route never clears", () => {
    expect(shouldClearForRepl([], false)).toBe(false);
    expect(shouldClearForRepl(["--help"], true)).toBe(false);
    expect(shouldClearForRepl([], true)).toBe(true);
  });
});
