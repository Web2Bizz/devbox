import { AppLogger } from "../logger";
import {
  STORAGE_UNAVAILABLE_MESSAGE,
  StorageUnavailableError,
} from "../exceptions/storage-unavailable.error";

export { STORAGE_UNAVAILABLE_MESSAGE };

/**
 * storageUnavailable — unified deny for the single REPOS_ROOT catalog.
 *
 * SCOPE: Common — common/storage next to the WorkspacePathService jail.
 *
 * REPOS_ROOT is the ONLY source of truth for reads AND writes. When it is
 * empty/whitespace (unconfigured), every storage READ (repos list, workspaces
 * tree/submodules, project-files tree, clone dest) funnels through here →
 * 503 EXTERNAL_UNAVAILABLE (Retry-After 30 via ApiErrorFilter), logged once
 * with the correlationId. Never carries paths, env values, or secrets to the
 * wire — `cause` stays off the envelope.
 *
 * Contrast: GET /projects + GET /projects/:id stay on the corrupted
 * `storage-unconfigured` flag (never 503 for those two); POST /projects
 * create stays 500 before any mkdir/INSERT. Jail/traversal checks (400/403)
 * run only AFTER this gate, on the configured root.
 */
export function storageUnavailable(
  operation: string,
  logger?: Pick<AppLogger, "error">,
  correlationId?: string,
  cause?: unknown,
): never {
  try {
    logger?.error(
      `[storage] unavailable operation=${operation} code=EXTERNAL_UNAVAILABLE`,
      correlationId,
    );
  } catch {
    // Logging must never mask the deny.
  }
  throw new StorageUnavailableError(operation, cause);
}

/**
 * Sync gate for resolveRoot() hot paths (no logger at hand — the caller logs
 * with its own AppLogger + correlationId via storageUnavailable, or lets this
 * throw propagate straight to ApiErrorFilter for the same 503 envelope).
 */
export function throwStorageNotConfigured(operation: string): never {
  throw new StorageUnavailableError(operation);
}
