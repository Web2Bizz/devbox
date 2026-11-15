const BACKEND_API_PATH = "/api/opencode";
const BACKEND_HEALTH_PATH = "/api/v1/health";

export function resolveBackendUrl(env: NodeJS.ProcessEnv = process.env): string {
  const raw = (env.RUSH_CODE_BACKEND_URL ?? "").trim();
  if (!raw) {
    throw new Error("[cli] RUSH_CODE_BACKEND_URL is required (set it to the backend base URL).");
  }

  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error("[cli] RUSH_CODE_BACKEND_URL must be an absolute http(s) URL.");
  }
  if (
    (parsed.protocol !== "http:" && parsed.protocol !== "https:") ||
    !parsed.hostname ||
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash
  ) {
    throw new Error("[cli] RUSH_CODE_BACKEND_URL must be an http(s) base URL without credentials, query, or fragment.");
  }
  return raw.replace(/\/+$/, "");
}

export function backendApiUrl(baseUrl: string): string {
  return `${baseUrl.replace(/\/+$/, "")}${BACKEND_API_PATH}`;
}

export function backendHealthUrl(baseUrl: string): string {
  return `${baseUrl.replace(/\/+$/, "")}${BACKEND_HEALTH_PATH}`;
}

export async function checkBackendHealth(
  env: NodeJS.ProcessEnv = process.env,
  fetchImpl: typeof fetch = fetch,
  timeoutMs = 2000,
): Promise<boolean> {
  let baseUrl: string;
  try {
    baseUrl = resolveBackendUrl(env);
  } catch {
    return false;
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(backendHealthUrl(baseUrl), {
      method: "GET",
      signal: controller.signal,
    });
    if (!response.ok) return false;
    const body: unknown = await response.json();
    return (
      typeof body === "object" &&
      body !== null &&
      !Array.isArray(body) &&
      (body as Record<string, unknown>).status === "ok"
    );
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}
