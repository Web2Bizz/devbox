import { NotFoundException } from '@nestjs/common';

/** True when the throw is the direct runner's honest missing-key signal. */
export function isMissingKey(error: unknown): boolean {
  if (!(error instanceof NotFoundException)) return false;
  const response: unknown = error.getResponse() as unknown;
  return (
    typeof response === 'object' &&
    response !== null &&
    (response as { code?: unknown }).code === 'opencode_key_missing'
  );
}
