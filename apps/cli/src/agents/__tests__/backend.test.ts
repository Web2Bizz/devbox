// CLI backend connection + health status tests.
import { afterEach, describe, expect, test } from "bun:test";
import { chatLocal, resetLocalSessionForTests } from "../opencode/index.js";
import {
  backendApiUrl,
  backendHealthUrl,
  checkBackendHealth,
  resolveBackendUrl,
} from "../../core/backend.js";

const env = { RUSH_CODE_BACKEND_URL: "https://backend.example.test/root/" } as NodeJS.ProcessEnv;

afterEach(() => resetLocalSessionForTests());

describe("Rush Code backend connection", () => {
  test("requires a valid backend URL without falling back to cloud or localhost", () => {
    expect(() => resolveBackendUrl({})).toThrow("RUSH_CODE_BACKEND_URL is required");
    expect(() => resolveBackendUrl({ RUSH_CODE_BACKEND_URL: "not-a-url" })).toThrow("absolute http(s)");
    expect(() => resolveBackendUrl({ RUSH_CODE_BACKEND_URL: "https://user:pass@example.test" })).toThrow(
      "without credentials",
    );
    expect(resolveBackendUrl(env)).toBe("https://backend.example.test/root");
    expect(backendApiUrl(resolveBackendUrl(env))).toBe("https://backend.example.test/root/api/opencode");
    expect(backendHealthUrl(resolveBackendUrl(env))).toBe("https://backend.example.test/root/api/v1/health");
  });

  test("chat uses backend OpenCode-compatible session and message endpoints", async () => {
    const seen: Array<{ url: string; body: string; authorization: string | undefined }> = [];
    const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
      seen.push({
        url: String(url),
        body: String(init?.body ?? ""),
        authorization: (init?.headers as Record<string, string> | undefined)?.Authorization,
      });
      if (seen.length === 1) {
        return new Response(JSON.stringify({ id: "session-1" }), { status: 200 });
      }
      return new Response(JSON.stringify({ parts: [{ type: "text", text: "backend reply" }] }), {
        status: 200,
      });
    }) as unknown as typeof fetch;

    const reply = await chatLocal("hello backend", { env, fetchImpl });
    expect(reply).toBe("backend reply");
    expect(seen.map(({ url }) => url)).toEqual([
      "https://backend.example.test/root/api/opencode/session",
      "https://backend.example.test/root/api/opencode/session/session-1/message",
    ]);
    expect(JSON.parse(seen[0]?.body ?? "{}")).toEqual({ title: "hello backend" });
    expect(JSON.parse(seen[1]?.body ?? "{}")).toEqual({
      parts: [{ type: "text", text: "hello backend" }],
    });
    expect(seen.every(({ authorization }) => authorization === undefined)).toBe(true);
    expect(seen.every(({ url }) => !url.includes("opencode.ai"))).toBe(true);
  });

  test("missing backend URL fails before issuing a request", async () => {
    let called = false;
    const fetchImpl = (async () => {
      called = true;
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;
    await expect(chatLocal("hello", { env: {}, fetchImpl })).rejects.toThrow("RUSH_CODE_BACKEND_URL is required");
    expect(called).toBe(false);
  });

  test("health status accepts only a successful backend health payload", async () => {
    const onlineFetch = (async (url: string | URL | Request) => {
      expect(String(url)).toBe("https://backend.example.test/root/api/v1/health");
      return Response.json({ status: "ok", db: "down" });
    }) as unknown as typeof fetch;
    const offlineFetch = (async () => new Response("unavailable", { status: 503 })) as unknown as typeof fetch;
    const malformedFetch = (async () => Response.json({ healthy: true })) as unknown as typeof fetch;

    expect(await checkBackendHealth(env, onlineFetch)).toBe(true);
    expect(await checkBackendHealth(env, offlineFetch)).toBe(false);
    expect(await checkBackendHealth(env, malformedFetch)).toBe(false);
    expect(await checkBackendHealth({}, onlineFetch)).toBe(false);
  });
});
