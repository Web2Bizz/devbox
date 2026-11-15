// agents/opencode/index — facade + backend-backed chat composition.
export * from "./constants.js";
export * from "./config.js";
export * from "./auth.js";
export * from "./text.js";
export * from "./cloud.js";
export * from "./serve.js";
export * from "./backend.js";

import { chatViaBackend, resetBackendSessionForTests, type ChatBackendOptions } from "./backend.js";

/** Free-text chat through the OpenCode-compatible Rush Code backend API. */
export async function chatLocal(prompt: string, opts: ChatBackendOptions = {}): Promise<string> {
  return chatViaBackend(prompt, opts);
}

export function resetLocalSessionForTests(): void {
  resetBackendSessionForTests();
}
