import { Injectable, UnauthorizedException } from "@nestjs/common";
import { AppLogger } from "../common/app-logger.service";
import { validateEnv } from "../env";

/**
 * uuid shape check — reuse of the ownUserId/isUserId pattern from
 * OpencodeKeysController (and UsersService.isUserId): a non-uuid caller id
 * (mock identities like 'default') → 401 before any upstream traffic.
 */
function isUserId(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}

/**
 * OpencodeAuthService — real-user gate for the serve paths.
 *
 * - Serve auth is the SERVER password (`OPENCODE_PASSWORD`, Basic
 *   base64("opencode:<password>")) — resolved from env by the callers
 *   (OpencodeSdkClient, ProxyService), NOT from per-user DB keys. The
 *   per-user DB Bearer is gone from the serve path: `opencode serve`
 *   always runs password-protected and rejects user-key Bearers with 401.
 * - This service keeps exactly one job: reject non-uuid caller ids (mock
 *   identities like 'default') with 401 `unauthorized` /
 *   "Authentication required" (same envelope as
 *   OpencodeKeysController.ownUserId) BEFORE any upstream call, so only
 *   real users reach the stand.
 * - No secrets here: the password is read from validateEnv inside
 *   serveBasicAuthHeader() below (never logged — callers trace only
 *   `auth=yes|no` + `scheme=basic`). Billing is untouched — OpencodeBillingService keeps
 *   its own findByUserId → decrypt lookup and never used this service.
 */
@Injectable()
export class OpencodeAuthService {
  constructor(
    private readonly logger: AppLogger = new AppLogger("OpencodeAuthService"),
  ) {}

  assertServeUser(userId: string, correlationId?: string): void {
    if (!isUserId(userId)) {
      this.logger.debug("[opencode-auth] non-uuid identity status=401 code=unauthorized", correlationId);
      throw new UnauthorizedException({
        code: "unauthorized",
        message: "Authentication required",
      });
    }
  }
}

/**
 * Serve Basic auth header — single source for the upstream `Authorization`
 * on ALL serve paths (OpencodeSdkClient.create, ProxyService.authHeaders).
 *
 * Reads OPENCODE_PASSWORD from env per call (validateEnv, never logged);
 * server-side Buffer base64 of `opencode:<password>` (never window.btoa).
 * Unset password (or unreadable env) → `{}` (no header at all — the
 * upstream 401 JSON is the honest signal, never masked, never a fallback
 * to per-user DB Bearers).
 */
export function serveBasicAuthHeader(): Record<string, string> {
  let password = "";
  try {
    password = validateEnv(process.env).opencodePassword;
  } catch {
    password = "";
  }
  if (!password) return {};
  return {
    authorization: `Basic ${Buffer.from(`opencode:${password}`, "utf8").toString("base64")}`,
  };
}
