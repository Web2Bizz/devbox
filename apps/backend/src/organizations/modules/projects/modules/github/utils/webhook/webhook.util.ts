import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * GitHub webhook signature helpers (multi-tenant install events).
 *
 * GitHub signs the EXACT raw request bytes with the webhook secret:
 *   X-Hub-Signature-256: sha256=<hex hmac-sha256(rawBody, secret)>
 * Verification must run over the raw buffer (captured by the express
 * json `verify` hook into request.rawBody) — never over re-serialized JSON,
 * whose whitespace/key order may differ. No secrets are logged here.
 */

const SIGNATURE_PREFIX: string = 'sha256=';

/** Extracts the raw request body captured by the json verify hook. */
export function getRawBody(request: unknown): Buffer | null {
  if (typeof request !== 'object' || request === null) return null;
  const raw: unknown = (request as { rawBody?: unknown }).rawBody;
  if (Buffer.isBuffer(raw)) return raw;
  if (typeof raw === 'string' && raw.length > 0) return Buffer.from(raw, 'utf8');
  return null;
}

/**
 * Constant-time HMAC-SHA256 verification of the
 * X-Hub-Signature-256 header against the raw body.
 * Returns false on missing/empty secret, header, or body.
 */
export function verifyWebhookSignature(
  rawBody: Buffer | string | null | undefined,
  signatureHeader: string | Array<string> | undefined,
  secret: string,
): boolean {
  if (!secret || !rawBody) return false;
  const header: string | Array<string> | undefined = Array.isArray(signatureHeader)
    ? signatureHeader[0]
    : signatureHeader;
  if (typeof header !== 'string' || !header.startsWith(SIGNATURE_PREFIX)) return false;
  const body: Buffer = typeof rawBody === 'string' ? Buffer.from(rawBody, 'utf8') : rawBody;
  if (body.length === 0) return false;
  const expectedHex: string = createHmac('sha256', secret).update(body).digest('hex');
  const expected: Buffer = Buffer.from(`${SIGNATURE_PREFIX}${expectedHex}`, 'utf8');
  const actual: Buffer = Buffer.from(header, 'utf8');
  if (expected.length !== actual.length) return false;
  try {
    return timingSafeEqual(expected, actual);
  } catch {
    return false;
  }
}

/** Minimal shape of the `installation` webhook event we handle. */
export type InstallationWebhookPayload = {
  action?: string;
  installation?: {
    id?: number;
    account?: { login?: string; type?: string };
    suspended_at?: string | null;
  };
};

/** Actions we act on; anything else (e.g. installation_repositories) is acked. */
export const INSTALLATION_ACTIONS: Set<string> = new Set<string>([
  'created',
  'deleted',
  'suspend',
  'unsuspend',
  'new_permissions_accepted',
]);
