// agents/opencode/config — env resolvers for cloud/serve (no secrets, no I/O).
import { OPENCODE_CLOUD_MODEL, OPENCODE_CLOUD_URL, OPENCODE_LOCAL_URL } from "./constants.js";

/** Chat model reference ({providerID, modelID} as serve upstream expects). */
export type OpencodeModelRef = {
  providerID: string;
  modelID: string;
};

/** Resolve cloud chat URL (explicit OPENCODE_CLOUD_URL override only). */
export function resolveCloudUrl(env: NodeJS.ProcessEnv = process.env): string {
  const custom = (env.OPENCODE_CLOUD_URL ?? "").trim();
  return (custom || OPENCODE_CLOUD_URL).replace(/\/+$/, "");
}

/** Resolve cloud model id (OPENCODE_MODEL wins, then OPENCODE_CLOUD_MODEL). */
export function resolveCloudModel(env: NodeJS.ProcessEnv = process.env): string {
  const raw = (env.OPENCODE_MODEL ?? "").trim() || (env.OPENCODE_CLOUD_MODEL ?? "").trim();
  return raw || OPENCODE_CLOUD_MODEL;
}

/** True when the optional serve fallback is explicitly enabled. */
export function isServeFallbackEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = (env.OPENCODE_USE_SERVE ?? "").trim().toLowerCase();
  return raw === "1" || raw === "true" || raw === "yes" || raw === "on";
}

/** Resolve local serve base (explicit env override only, never silent). */
export function resolveLocalBaseUrl(env: NodeJS.ProcessEnv = process.env): string {
  const custom =
    (env.OPENCODE_URL ?? "").trim() || (env.OPENCODE_SERVER_URL ?? "").trim();
  const base = (custom || OPENCODE_LOCAL_URL).replace(/\/+$/, "");
  // Mirror OpencodeService.dialUrl(): 0.0.0.0 / :: are undialable —
  // probe 127.0.0.1 instead. The configured value is kept verbatim
  // everywhere except this outbound dial remap.
  try {
    const parsed = new URL(base);
    if (parsed.hostname === "0.0.0.0" || parsed.hostname === "::") {
      parsed.hostname = "127.0.0.1";
      return parsed.toString().replace(/\/+$/, "");
    }
  } catch {
    return base;
  }
  return base;
}

/**
 * Serve password for the OPTIONAL fallback (`opencode serve` prints it on
 * boot, same secret as backend OPENCODE_TOKEN env; alias
 * OPENCODE_SERVER_PASSWORD). '' = serve without password → header omitted.
 * Value is never logged.
 */
export function resolveServeToken(env: NodeJS.ProcessEnv = process.env): string {
  return (env.OPENCODE_TOKEN ?? "").trim() || (env.OPENCODE_SERVER_PASSWORD ?? "").trim();
}

/**
 * Parse OPENCODE_MODEL="providerID/modelID" for the serve fallback
 * (surrounding whitespace and extra slashes trimmed;
 * "provider/model/extra" keeps the tail as modelID). Returns null when
 * unset or malformed (caller omits `model`). Cloud uses the raw string
 * as-is (OpenAI-compatible model id), so this parses only the fallback.
 */
export function parseModelRef(raw: string): OpencodeModelRef | null {
  const clean = raw.trim().replace(/^\/+|\/+$/g, "");
  const slash = clean.indexOf("/");
  if (slash <= 0 || slash >= clean.length - 1) return null;
  const providerID = clean.slice(0, slash).trim();
  const modelID = clean.slice(slash + 1).trim().replace(/^\/+|\/+$/g, "");
  if (!providerID || !modelID) return null;
  return { providerID, modelID };
}

/**
 * Resolve the serve-fallback model: explicit OPENCODE_MODEL only;
 * undefined = serve default (no `model` sent). jev ("jev-1.13-free") is
 * rejected on purpose: SystemOne is choice-only, not a chat provider.
 */
export function resolveChatModel(env: NodeJS.ProcessEnv = process.env): OpencodeModelRef | undefined {
  const raw = (env.OPENCODE_MODEL ?? "").trim();
  if (!raw) return undefined;
  const ref = parseModelRef(raw);
  if (!ref) return undefined;
  if (ref.providerID.toLowerCase() === "jev" || ref.modelID === "jev-1.13-free") return undefined;
  return ref;
}
