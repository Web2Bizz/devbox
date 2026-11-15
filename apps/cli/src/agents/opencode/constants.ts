// agents/opencode/constants — timeouts, URLs, SDK pin, missing-key message.
export const OPENCODE_TIMEOUT_MS = 30_000;
export const OPENCODE_CAUSE_MAX = 2000;
/** Preview slice shown in errorBox (full cause ≤2000 stays in message). */
export const OPENCODE_CAUSE_PREVIEW = 500;

/** Pinned SDK version the OPTIONAL serve fallback mirrors (same as backend). */
export const OPENCODE_SDK_VERSION = "1.18.33";

/**
 * Direct cloud chat endpoint (documented inference endpoint, see header).
 * Explicit override only via OPENCODE_CLOUD_URL (never silent, never from
 * auth.json). Default has no trailing slash.
 */
export const OPENCODE_CLOUD_URL = "https://opencode.ai/inference/openai/v1/chat/completions";

/** Default cloud model (DeepSeek V4.1 Flash; override via OPENCODE_MODEL). */
export const OPENCODE_CLOUD_MODEL = "deepseek-v4.1-flash";

/** Local serve base for the OPTIONAL fallback (never required by default). */
export const OPENCODE_LOCAL_URL = "http://127.0.0.1:4096";

export const MISSING_KEY_MESSAGE =
  "[cli] missing opencode key in auth.json → вставь через /connect в TUI " +
  "(см. apps/cli/.env.example).";
