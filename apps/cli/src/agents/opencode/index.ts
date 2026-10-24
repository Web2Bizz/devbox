// agents/opencode/index — facade: re-exports + chatLocal composition (cloud-first).
// Decision (2026-10-23, documented in apps/cli/README § Chat/Env):
// Canon + context7 have NO proven direct cloud chat for the Go subscription
// via SDK serve-only paths; SystemOne is choice-only; billing/usage is not
// chat. Documented inference endpoint:
// base https://opencode.ai/inference + OpenAI-compatible
// `/openai/v1/chat/completions`. Default OPENCODE_CLOUD_URL mirrors it.
// Transport: cloud-first (Bearer from auth.json only, timeout 30s, 1 retry
// on network/429/5xx, scrub Bearer/URL→[redacted], cause≤2000, fail-fast
// missing key). Serve is OPTIONAL fallback only, behind explicit
// OPENCODE_USE_SERVE=1. Key source: auth.json ONLY (env never read).
export * from "./constants.js";
export * from "./config.js";
export * from "./auth.js";
export * from "./text.js";
export * from "./cloud.js";
export * from "./serve.js";

import { isServeFallbackEnabled } from "./config.js";
import { chatCloud } from "./cloud.js";
import { chatViaServe, resetLocalSessionForTests, type ChatLocalOptions } from "./serve.js";

/**
 * Free-text chat (cloud-first, same signature as before). Default: direct
 * cloud via chatCloud (needs auth.json key only, no localhost, env key vars
 * ignored). Serve is tried ONLY when explicit OPENCODE_USE_SERVE=1 and cloud
 * failed. Reply always text, never empty and never "answer"/"reply".
 */
export async function chatLocal(prompt: string, opts: ChatLocalOptions = {}): Promise<string> {
  const env = opts.env ?? process.env;
  try {
    return await chatCloud(prompt, {
      timeoutMs: opts.timeoutMs,
      fetchImpl: opts.fetchImpl,
      env,
      endpoint: opts.endpoint,
      model: typeof env.OPENCODE_MODEL === "string" && !env.OPENCODE_MODEL.includes("/") ? env.OPENCODE_MODEL.trim() || undefined : undefined,
    });
  } catch (cloudErr) {
    if (!isServeFallbackEnabled(env)) throw cloudErr;
    resetLocalSessionForTests();
    return chatViaServe(prompt, opts);
  }
}
