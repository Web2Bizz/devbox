import { z } from "zod";

/**
 * PUT /api/v1/opencode/key — the caller's own OpenCode API key.
 * Min 20 chars (real keys are long opaque tokens; short strings are almost
 * certainly a paste mistake), max 1024, trimmed. The value is encrypted with
 * CryptoService before storage and is never returned or logged.
 */
export const opencodeKeySchema = z.object({
  apiKey: z
    .string()
    .trim()
    .min(20, { error: "must be at least 20 characters" })
    .max(1024, { error: "must be ≤ 1024 chars" }),
});

export type OpencodeKeyInput = z.infer<typeof opencodeKeySchema>;
