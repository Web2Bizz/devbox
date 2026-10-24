// opencode key/client tests: missing-key fail-fast, scrub, /agent parse.
// Direct cloud chat (OpenAI-compatible choices → text, no serve by default).
// Key source: auth.json ONLY — env key vars are never read.
// Run: bun test --isolate src (apps/cli).

import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  OPENCODE_CAUSE_MAX,
  OPENCODE_CAUSE_PREVIEW,
  OPENCODE_CLOUD_MODEL,
  OPENCODE_CLOUD_URL,
  OPENCODE_LOCAL_URL,
  OPENCODE_SDK_VERSION,
  chatCloud,
  chatLocal,
  classify400Cause,
  formatKeySource,
  getOpencodeKey,
  getOpencodeKeyInfo,
  hasOpencodeKey,
  isServeFallbackEnabled,
  opencodeAuthPath,
  parseModelRef,
  resetLocalSessionForTests,
  resolveChatModel,
  resolveCloudModel,
  resolveCloudUrl,
  resolveLocalBaseUrl,
  resolveServeToken,
  scrubOpencodeText,
} from "../opencode/index.js";
import {
  CLEAR_SEQUENCE,
  PROMPT_LABEL,
  clearScreen,
  parseLine,
  shouldClearForRepl,
} from "../../prompt/repl.js";
import { errorText, greetingLines } from "../../ui/shared/plain.js";

function makeAuthDir(payload: unknown): { dir: string; env: NodeJS.ProcessEnv } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "devbox-cli-auth-"));
  fs.mkdirSync(path.join(dir, "opencode"), { recursive: true });
  const body = typeof payload === "string" ? payload : JSON.stringify(payload);
  fs.writeFileSync(path.join(dir, "opencode", "auth.json"), body);
  return { dir, env: { XDG_DATA_HOME: dir } as NodeJS.ProcessEnv };
}

function makeMissingEnv(): { dir: string; env: NodeJS.ProcessEnv } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "devbox-cli-no-key-"));
  // No auth.json inside → ENOENT path.
  return { dir, env: { XDG_DATA_HOME: dir } as NodeJS.ProcessEnv };
}

function cleanup(dir: string): void {
  fs.rmSync(dir, { recursive: true, force: true });
}

describe("opencode key (auth.json only)", () => {
  test("missing file fails fast with path, no secret", () => {
    const { dir, env } = makeMissingEnv();
    try {
      const expectedPath = opencodeAuthPath(env);
      expect(() => getOpencodeKey(env)).toThrow("auth.json");
      expect(() => getOpencodeKey(env)).toThrow(expectedPath);
      expect(() => getOpencodeKey(env)).toThrow("missing opencode key");
      expect(hasOpencodeKey(env)).toBe(false);
    } finally {
      cleanup(dir);
    }
  });

  test("broken JSON fails fast with path", () => {
    const { dir, env } = makeAuthDir("{not-json");
    try {
      const expectedPath = opencodeAuthPath(env);
      expect(() => getOpencodeKey(env)).toThrow(expectedPath);
      expect(hasOpencodeKey(env)).toBe(false);
    } finally {
      cleanup(dir);
    }
  });

  test("empty/non-string key fails fast with path", () => {
    const cases: unknown[] = [
      { "opencode-go": { key: "   " }, opencode: { key: "x" } },
      { "opencode-go": { key: 123 } },
      {},
    ];
    for (const payload of cases) {
      const { dir, env } = makeAuthDir(payload);
      try {
        expect(() => getOpencodeKey(env)).toThrow(opencodeAuthPath(env));
      } finally {
        cleanup(dir);
      }
    }
  });

  test("env key vars are ignored even when set (file wins)", () => {
    const { dir, env } = makeAuthDir({ "opencode-go": { key: "  file-key\n" }, opencode: { key: "other" } });
    try {
      expect(getOpencodeKey(env)).toBe("file-key");
      expect(getOpencodeKey({ ...env, OPENCODE_API_KEY: " env-key " })).toBe("file-key");
      expect(getOpencodeKey({ ...env, JEV_API_KEY: "jev-key" })).toBe("file-key");
      expect(hasOpencodeKey({ ...env, OPENCODE_API_KEY: "env-key" })).toBe(true);
      expect(hasOpencodeKey(makeMissingEnv().env)).toBe(false);
    } finally {
      cleanup(dir);
    }
  });

  test("trims value, opencode-go has priority over opencode", () => {
    const a = makeAuthDir({ "opencode-go": { key: "  file-key\n" }, opencode: { key: "other" } });
    try {
      expect(getOpencodeKey(a.env)).toBe("file-key");
    } finally {
      cleanup(a.dir);
    }
    const b = makeAuthDir({ opencode: { key: "  legacy-key  " } });
    try {
      expect(getOpencodeKey(b.env)).toBe("legacy-key");
    } finally {
      cleanup(b.dir);
    }
  });

  test("scrub hides Bearer and URL creds (no secret in output)", () => {
    const dirty = "Authorization: Bearer super-secret-123 and postgres://u:p@ss@host/db";
    const clean = scrubOpencodeText(dirty);
    expect(clean).toContain("Bearer [redacted]");
    expect(clean).not.toContain("super-secret-123");
    expect(clean).toContain("[redacted]@");
  });

  test("chat error cause is scrubbed and capped", async () => {
    const { dir, env } = makeAuthDir({ "opencode-go": { key: "k" } });
    try {
      resetLocalSessionForTests();
      const failingFetch = (async () => {
        throw new TypeError("fetch failed for Bearer abcdef");
      }) as unknown as typeof fetch;
      await expect(
        chatLocal("hello", {
          env,
          fetchImpl: failingFetch,
          timeoutMs: 1000,
        }),
      ).rejects.toThrow("[redacted]");
      resetLocalSessionForTests();
    } finally {
      cleanup(dir);
    }
  });

  test("missing key fails fast before any fetch (no localhost required)", async () => {
    const { dir, env } = makeMissingEnv();
    try {
      let called = 0;
      const neverFetch = (async () => {
        called += 1;
        return new Response("{}", { status: 200 });
      }) as unknown as typeof fetch;
      await expect(chatLocal("hello", { env, fetchImpl: neverFetch })).rejects.toThrow(
        "auth.json",
      );
      expect(called).toBe(0);
      resetLocalSessionForTests();
    } finally {
      cleanup(dir);
    }
  });
});

describe("opencode cloud endpoint (Zen composition)", () => {
  test("sdk version pins the serve-fallback contract", () => {
    expect(OPENCODE_SDK_VERSION).toBe("1.18.33");
  });

  test("cloud url/model defaults + explicit override", () => {
    const { dir, env } = makeAuthDir({ "opencode-go": { key: "k" } });
    try {
      expect(OPENCODE_CLOUD_URL).toBe("https://opencode.ai/inference/openai/v1/chat/completions");
      expect(OPENCODE_CLOUD_MODEL).toBe("deepseek-v4.1-flash");
      expect(resolveCloudUrl(env)).toBe(OPENCODE_CLOUD_URL);
      expect(resolveCloudModel(env)).toBe(OPENCODE_CLOUD_MODEL);
      expect(resolveCloudUrl({ ...env, OPENCODE_CLOUD_URL: "https://stage.example.com/x/" })).toBe(
        "https://stage.example.com/x",
      );
      expect(resolveCloudModel({ ...env, OPENCODE_MODEL: "custom-model" })).toBe("custom-model");
    } finally {
      cleanup(dir);
    }
  });

  test("serve fallback is OFF by default, ON only with explicit flag", () => {
    const { dir, env } = makeAuthDir({ "opencode-go": { key: "k" } });
    try {
      expect(isServeFallbackEnabled(env)).toBe(false);
      expect(isServeFallbackEnabled({ ...env, OPENCODE_USE_SERVE: "1" })).toBe(true);
      expect(isServeFallbackEnabled({ ...env, OPENCODE_USE_SERVE: "true" })).toBe(true);
    } finally {
      cleanup(dir);
    }
  });

  test("local base default + dial remap (fallback only)", () => {
    const { dir, env } = makeAuthDir({ "opencode-go": { key: "k" } });
    try {
      expect(OPENCODE_LOCAL_URL).toBe("http://127.0.0.1:4096");
      expect(resolveLocalBaseUrl(env)).toBe("http://127.0.0.1:4096");
      expect(resolveLocalBaseUrl({ ...env, OPENCODE_URL: "http://localhost:4096/" })).toBe(
        "http://localhost:4096",
      );
      expect(resolveLocalBaseUrl({ ...env, OPENCODE_SERVER_URL: "http://0.0.0.0:4096" })).toBe(
        "http://127.0.0.1:4096",
      );
    } finally {
      cleanup(dir);
    }
  });

  test("serve token: OPENCODE_TOKEN wins, SERVER_PASSWORD alias, empty omits", () => {
    const { dir, env } = makeAuthDir({ "opencode-go": { key: "k" } });
    try {
      expect(resolveServeToken(env)).toBe("");
      expect(resolveServeToken({ ...env, OPENCODE_TOKEN: " x " })).toBe("x");
      expect(resolveServeToken({ ...env, OPENCODE_SERVER_PASSWORD: "pw" })).toBe("pw");
    } finally {
      cleanup(dir);
    }
  });

  test("model: jev rejected for serve fallback (choice-only)", () => {
    const { dir, env } = makeAuthDir({ "opencode-go": { key: "k" } });
    try {
      expect(resolveChatModel(env)).toBeUndefined();
      expect(parseModelRef("deepseek/deepseek-chat")).toEqual({
        providerID: "deepseek",
        modelID: "deepseek-chat",
      });
      expect(parseModelRef("no-slash")).toBeNull();
      expect(resolveChatModel({ ...env, OPENCODE_MODEL: "jev/jev-1.13-free" })).toBeUndefined();
    } finally {
      cleanup(dir);
    }
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

describe("opencode direct cloud chat (free text, no serve)", () => {
  // Cloud mock: POST {model, messages} → {choices:[{message:{content}}]}.
  function cloudFetch(seen: { urls: string[]; auth?: string; bodies: string[] }, text = "hello world") {
    return (async (url: string | URL | Request, init?: RequestInit) => {
      const u = String(url);
      seen.urls.push(u);
      const headers = (init?.headers ?? {}) as Record<string, string>;
      if (headers.Authorization) seen.auth = `redacted:${typeof headers.Authorization === "string" ? headers.Authorization.length : 0}`;
      // Record only that a Bearer header was sent + its redacted length —
      // never the raw key value.
      seen.bodies.push(String(init?.body ?? ""));
      return new Response(JSON.stringify({ choices: [{ message: { content: text } }] }), {
        status: 200,
      });
    }) as unknown as typeof fetch;
  }

  test("posts cloud model/messages with Bearer, shows text (never empty/answer)", async () => {
    const { dir, env } = makeAuthDir({ "opencode-go": { key: "k" } });
    try {
      resetLocalSessionForTests();
      const seen = { urls: [] as string[], auth: undefined as string | undefined, bodies: [] as string[] };
      const reply = await chatLocal("hello world", {
        env,
        fetchImpl: cloudFetch(seen),
      });
      expect(seen.urls).toHaveLength(1);
      expect(seen.urls[0]).toBe(OPENCODE_CLOUD_URL);
      expect(seen.urls[0]).not.toContain("127.0.0.1");
      expect(seen.urls[0]).not.toContain("localhost");
      const body = JSON.parse(seen.bodies[0]) as Record<string, unknown>;
      expect(body).toMatchObject({
        model: OPENCODE_CLOUD_MODEL,
        messages: [{ role: "user", content: "hello world" }],
      });
      expect(reply).toBe("hello world");
      expect(reply.trim()).not.toBe("");
      expect(reply.trim().toLowerCase()).not.toBe("answer");
      expect(seen.auth).toMatch(/^redacted:/);
      resetLocalSessionForTests();
    } finally {
      cleanup(dir);
    }
  });

  test("chatCloud sends OPENCODE_MODEL override + Bearer from file", async () => {
    const { dir, env } = makeAuthDir({ "opencode-go": { key: "file-live-key" } });
    try {
      const seen = { urls: [] as string[], auth: undefined as string | undefined, bodies: [] as string[] };
      let rawAuth = "";
      const capture = (async (url: string | URL | Request, init?: RequestInit) => {
        rawAuth = String((init?.headers as Record<string, string>)?.Authorization ?? "");
        seen.urls.push(String(url));
        seen.bodies.push(String(init?.body ?? ""));
        return new Response(JSON.stringify({ choices: [{ message: { content: "ok" } }] }), {
          status: 200,
        });
      }) as unknown as typeof fetch;
      const reply = await chatCloud("hi", {
        env: { ...env, OPENCODE_MODEL: "custom-model", OPENCODE_API_KEY: "ignored-env-key" } as NodeJS.ProcessEnv,
        fetchImpl: capture,
      });
      expect(reply).toBe("ok");
      expect(rawAuth).toBe("Bearer file-live-key");
      expect(JSON.parse(seen.bodies[0])).toMatchObject({ model: "custom-model" });
      resetLocalSessionForTests();
    } finally {
      cleanup(dir);
    }
  });

  test("choices[] text joined, scrubbed; empty/answer → shape mismatch", async () => {
    const { dir, env } = makeAuthDir({ "opencode-go": { key: "k" } });
    try {
      const multiFetch = (async () =>
        new Response(
          JSON.stringify({
            choices: [{ message: { content: "part one" } }, { delta: { content: "Bearer abc" } }],
          }),
          { status: 200 },
        )) as unknown as typeof fetch;
      const reply = await chatLocal("hi", { env, fetchImpl: multiFetch });
      expect(reply).toContain("part one");
      expect(reply).toContain("Bearer [redacted]");
      expect(reply).not.toContain("abc");
      resetLocalSessionForTests();
      const emptyFetch = (async () =>
        new Response(JSON.stringify({ choices: [] }), { status: 200 })) as unknown as typeof fetch;
      await expect(chatLocal("hi", { env, fetchImpl: emptyFetch })).rejects.toThrow("empty reply");
      resetLocalSessionForTests();
      const answerFetch = (async () =>
        new Response(JSON.stringify({ choices: [{ message: { content: "answer" } }] }), {
          status: 200,
        })) as unknown as typeof fetch;
      await expect(chatLocal("hi", { env, fetchImpl: answerFetch })).rejects.toThrow("empty reply");
      resetLocalSessionForTests();
    } finally {
      cleanup(dir);
    }
  });

  test("401 maps to /connect hint (never the secret)", async () => {
    const { dir, env } = makeAuthDir({ "opencode-go": { key: "k" } });
    try {
      const deniedFetch = (async () =>
        new Response(JSON.stringify({ type: "error" }), { status: 401 })) as unknown as typeof fetch;
      await expect(chatLocal("hi", { env, fetchImpl: deniedFetch })).rejects.toThrow("status=401");
      await expect(chatLocal("hi", { env, fetchImpl: deniedFetch })).rejects.toThrow("/connect");
      resetLocalSessionForTests();
    } finally {
      cleanup(dir);
    }
  });

  test("404 maps to endpoint hint (documented inference endpoint)", async () => {
    const { dir, env } = makeAuthDir({ "opencode-go": { key: "k" } });
    try {
      const missingFetch = (async () => new Response("nope", { status: 404 })) as unknown as typeof fetch;
      await expect(chatLocal("hi", { env, fetchImpl: missingFetch })).rejects.toThrow("documented inference");
      resetLocalSessionForTests();
    } finally {
      cleanup(dir);
    }
  });

  test("serve fallback stays optional: cloud failure without flag never dials localhost", async () => {
    const { dir, env } = makeAuthDir({ "opencode-go": { key: "k" } });
    try {
      const urls: string[] = [];
      const failingCloud = (async (url: string | URL | Request) => {
        urls.push(String(url));
        return new Response("busy", { status: 503 });
      }) as unknown as typeof fetch;
      await expect(chatLocal("hi", { env, fetchImpl: failingCloud, timeoutMs: 1000 })).rejects.toThrow(
        "cloud",
      );
      expect(urls).toHaveLength(2);
      expect(urls.every((u) => !u.includes("127.0.0.1") && !u.includes("localhost"))).toBe(true);
      resetLocalSessionForTests();
    } finally {
      cleanup(dir);
    }
  });

  test("serve fallback runs only with OPENCODE_USE_SERVE=1 (cloud down → serve text)", async () => {
    const { dir, env } = makeAuthDir({ "opencode-go": { key: "k" } });
    try {
      resetLocalSessionForTests();
      let calls = 0;
      const mixedFetch = (async (url: string | URL | Request) => {
        calls += 1;
        const u = String(url);
        // First two calls are cloud (fail), then serve session + message (ok).
        if (u === OPENCODE_CLOUD_URL) return new Response("busy", { status: 503 });
        if (u.endsWith("/session")) {
          return new Response(JSON.stringify({ id: "ses_fallback_1" }), { status: 200 });
        }
        return new Response(JSON.stringify({ parts: [{ type: "text", text: "via serve" }] }), {
          status: 200,
        });
      }) as unknown as typeof fetch;
      const reply = await chatLocal("hi", {
        env: { ...env, OPENCODE_USE_SERVE: "1" } as NodeJS.ProcessEnv,
        fetchImpl: mixedFetch,
      });
      expect(reply).toBe("via serve");
      expect(calls).toBeGreaterThanOrEqual(3);
      resetLocalSessionForTests();
    } finally {
      cleanup(dir);
    }
  });
});

describe("repl startup keeps fail-fast errors after clear", () => {
  test("start writes clear first, then single greeting block, prompt stays bottom", () => {
    const writes: string[] = [];
    const write = (s: string): void => void writes.push(s);
    clearScreen(write);
    write(greetingLines("0.1.0").join("\n"));
    write(PROMPT_LABEL);
    expect([...(writes[0] as string)].map((c) => c.charCodeAt(0))).toEqual([27, 99]);
    expect(writes[1]).toContain("◆ DEVBOX CLI v0.1.0");
    expect(writes[1]).toContain("prompt >");
    expect(writes[1]).toContain("@file");
    expect(writes[1]).toContain("/agent");
    expect(writes[1]).toContain("/help");
    expect(writes[1]).toContain("/exit");
    const startup = writes.join("\n");
    expect(startup).not.toContain("╔");
    expect(startup).not.toContain("╚");
    expect(startup).not.toContain("┌");
    expect(startup).not.toContain("┘");
    expect(writes[writes.length - 1]).toBe("prompt > ");
  });

  test("missing-key error surfaces after clear in ✗ lines (nothing lost)", () => {
    const { dir, env } = makeMissingEnv();
    try {
      const writes: string[] = [];
      writes.push(CLEAR_SEQUENCE);
      let message = "";
      try {
        getOpencodeKey(env);
      } catch (err) {
        message = err instanceof Error ? err.message : String(err);
      }
      expect(message).toContain("auth.json");
      expect(message).toContain(opencodeAuthPath(env));
      writes.push(errorText(message, "Вставь ключ через /connect в TUI (см. apps/cli/.env.example)."));
      expect(writes[0]).toBe(CLEAR_SEQUENCE);
      expect(writes[1]).toContain("✗");
      expect(writes[1]).toContain("auth.json");
      expect(writes.join("\n")).not.toContain("Bearer super-secret");
    } finally {
      cleanup(dir);
    }
  });

  test("non-TTY help route never clears", () => {
    expect(shouldClearForRepl([], false)).toBe(false);
    expect(shouldClearForRepl(["--help"], true)).toBe(false);
    expect(shouldClearForRepl([], true)).toBe(true);
  });
});

describe("400 diagnostics (no value, full scrubbed cause, no serv… cut)", () => {
  test("key info exposes len/perms/uid, never the value", () => {
    const { dir, env } = makeAuthDir({ "opencode-go": { key: "live-secret-123" } });
    try {
      const info = getOpencodeKeyInfo(env);
      expect(info.exists).toBe(true);
      expect(info.keyLen).toBe("live-secret-123".length);
      expect(info.path).toBe(opencodeAuthPath(env));
      expect(info.modeOct).toMatch(/^[0-7]+$/);
      const src = formatKeySource(info);
      expect(src).toContain("key_len=");
      expect(src).toContain("perms=");
      expect(src).toContain("uid_match=");
      expect(src).toContain(info.path);
      expect(src).not.toContain("live-secret-123");
      expect(JSON.stringify(info)).not.toContain("live-secret-123");
    } finally {
      cleanup(dir);
    }
  });

  test("missing/unreadable file → exists=false with path + reason", () => {
    const { dir, env } = makeMissingEnv();
    try {
      const info = getOpencodeKeyInfo(env);
      expect(info.exists).toBe(false);
      expect(info.keyLen).toBe(0);
      expect(info.path).toBe(opencodeAuthPath(env));
      expect(info.reason).toBeTruthy();
    } finally {
      cleanup(dir);
    }
  });

  test("400 carries endpoint/model/key_len/body-shape + scrubbed preview", async () => {
    const { dir, env } = makeAuthDir({ "opencode-go": { key: "k123" } });
    try {
      resetLocalSessionForTests();
      const badFetch = (async () =>
        new Response(JSON.stringify({ error: { type: "service_unavailable", message: "bad model" } }), {
          status: 400,
        })) as unknown as typeof fetch;
      const err = await chatLocal("hello", { env, fetchImpl: badFetch }).catch((e: unknown) =>
        e instanceof Error ? e : new Error(String(e)),
      );
      expect(err.message).toContain("status=400");
      expect(err.message).toContain("endpoint=");
      expect(err.message).toContain(OPENCODE_CLOUD_URL);
      expect(err.message).toContain(`model=${OPENCODE_CLOUD_MODEL}`);
      expect(err.message).toContain("key_len=");
      expect(err.message).toContain("key_source=");
      expect(err.message).toContain("body-shape={model,messages:1}");
      expect(err.message).toContain("cause=");
      // Full cause present (no {"error":{"type":"serv… cut): wrap shows all.
      expect(err.message).toContain("service_unavailable");
      expect(err.message).not.toContain("k123");
      expect(classify400Cause(err.message)).toBe("service");
      resetLocalSessionForTests();
    } finally {
      cleanup(dir);
    }
  });

  test("400 invalid-key vs service hints differ; Bearer scrubbed, capped", async () => {
    expect(classify400Cause("Invalid API key provided")).toBe("invalid-key");
    expect(classify400Cause("model does not exist")).toBe("service");
    expect(classify400Cause("something odd")).toBe("generic");
    const { dir, env } = makeAuthDir({ "opencode-go": { key: "k" } });
    try {
      resetLocalSessionForTests();
      const secretBody = `Bearer super-secret-xyz ${"z".repeat(OPENCODE_CAUSE_MAX + 100)}`;
      const leakFetch = (async () => new Response(secretBody, { status: 400 })) as unknown as typeof fetch;
      const err = await chatLocal("hi", { env, fetchImpl: leakFetch }).catch((e: unknown) =>
        e instanceof Error ? e : new Error(String(e)),
      );
      expect(err.message).toContain("Bearer [redacted]");
      expect(err.message).not.toContain("super-secret-xyz");
      expect(err.message.length).toBeLessThanOrEqual(OPENCODE_CAUSE_MAX + 600);
      expect(OPENCODE_CAUSE_PREVIEW).toBe(500);
      const boxed = errorText(err.message, "hint line");
      // errorText keeps the full cause (never …-cuts).
      expect(boxed).toContain("service");
      expect(boxed).toContain("✗");
      expect(boxed).toContain("→ hint line");
      expect(boxed).not.toMatch(/serv…/);
      expect(boxed).not.toContain("┌");
      expect(boxed).not.toContain("│");
      resetLocalSessionForTests();
    } finally {
      cleanup(dir);
    }
  });
});
