/**
 * Webhook util checks — self-contained runner (plain node:assert, no deps).
 *
 * Runs against COMPILED dist:
 *   `bun run build && bun dist/organizations/modules/projects/modules/github/utils/webhook/__tests__/webhook.spec.js`
 * Also executes under `bun test dist` (top-level run, throws on failure).
 *
 * Covers the GitHub webhook contract:
 * - getRawBody: Buffer, non-empty string, missing/null/non-object shapes;
 * - verifyWebhookSignature: valid HMAC-SHA256, wrong signature, missing
 *   header, wrong prefix, empty secret, empty body, array header;
 * - INSTALLATION_ACTIONS: exactly the handled installation lifecycle set.
 *
 * No secrets are logged here — the fixture secret is an opaque literal.
 */
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import {
  INSTALLATION_ACTIONS,
  getRawBody,
  verifyWebhookSignature,
} from "../webhook.util";

const SECRET = "webhook-spec-secret";
const BODY = '{"action":"created","installation":{"id":42}}';
const RAW = Buffer.from(BODY, "utf8");

/** GitHub's own signing shape: sha256=<hex hmac-sha256(body, secret)>. */
function sign(body: Buffer | string, secret = SECRET): string {
  const buf = typeof body === "string" ? Buffer.from(body, "utf8") : body;
  return `sha256=${createHmac("sha256", secret).update(buf).digest("hex")}`;
}

const checks: Array<{ name: string; run: () => Promise<void> | void }> = [
  // --- getRawBody -------------------------------------------------------
  {
    name: "getRawBody returns the captured Buffer untouched",
    run: () => {
      const raw = getRawBody({ rawBody: RAW });
      assert.ok(Buffer.isBuffer(raw));
      assert.equal(raw?.toString("utf8"), BODY);
    },
  },
  {
    name: "getRawBody converts a non-empty string to a Buffer",
    run: () => {
      const raw = getRawBody({ rawBody: BODY });
      assert.ok(Buffer.isBuffer(raw));
      assert.equal(raw?.toString("utf8"), BODY);
    },
  },
  {
    name: "getRawBody returns null when rawBody is missing or empty",
    run: () => {
      assert.equal(getRawBody({}), null);
      assert.equal(getRawBody({ rawBody: "" }), null);
      assert.equal(getRawBody({ rawBody: 42 }), null);
      assert.equal(getRawBody(null), null);
      assert.equal(getRawBody(undefined), null);
      assert.equal(getRawBody("not-a-request"), null);
    },
  },

  // --- verifyWebhookSignature -------------------------------------------
  {
    name: "verifyWebhookSignature accepts a valid HMAC over the raw body",
    run: () => {
      assert.equal(verifyWebhookSignature(RAW, sign(RAW), SECRET), true);
      // String raw body is hashed with the same utf8 bytes.
      assert.equal(verifyWebhookSignature(BODY, sign(BODY), SECRET), true);
    },
  },
  {
    name: "verifyWebhookSignature rejects a wrong signature",
    run: () => {
      const good = sign(RAW);
      const flipped = `${good.slice(0, -1)}${good.endsWith("0") ? "1" : "0"}`;
      assert.equal(verifyWebhookSignature(RAW, flipped, SECRET), false);
      // Signature made with another secret must not pass either.
      assert.equal(verifyWebhookSignature(RAW, sign(RAW, "other-secret"), SECRET), false);
      // Tampered body under a valid-for-original signature.
      assert.equal(
        verifyWebhookSignature(Buffer.from(`${BODY} `, "utf8"), sign(RAW), SECRET),
        false,
      );
    },
  },
  {
    name: "verifyWebhookSignature rejects a missing header",
    run: () => {
      assert.equal(verifyWebhookSignature(RAW, undefined, SECRET), false);
      assert.equal(verifyWebhookSignature(RAW, "", SECRET), false);
      assert.equal(verifyWebhookSignature(RAW, null as unknown as string, SECRET), false);
    },
  },
  {
    name: "verifyWebhookSignature rejects a wrong prefix",
    run: () => {
      const hex = sign(RAW).slice("sha256=".length);
      assert.equal(verifyWebhookSignature(RAW, `sha1=${hex}`, SECRET), false);
      assert.equal(verifyWebhookSignature(RAW, hex, SECRET), false);
      assert.equal(verifyWebhookSignature(RAW, `sha256:${hex}`, SECRET), false);
    },
  },
  {
    name: "verifyWebhookSignature rejects an empty secret",
    run: () => {
      assert.equal(verifyWebhookSignature(RAW, sign(RAW, ""), ""), false);
      assert.equal(verifyWebhookSignature(RAW, sign(RAW), ""), false);
    },
  },
  {
    name: "verifyWebhookSignature rejects an empty body",
    run: () => {
      assert.equal(verifyWebhookSignature(Buffer.alloc(0), sign(Buffer.alloc(0)), SECRET), false);
      assert.equal(verifyWebhookSignature("", sign(""), SECRET), false);
      assert.equal(verifyWebhookSignature(null, sign(RAW), SECRET), false);
      assert.equal(verifyWebhookSignature(undefined, sign(RAW), SECRET), false);
    },
  },
  {
    name: "verifyWebhookSignature reads the first value of an array header",
    run: () => {
      assert.equal(verifyWebhookSignature(RAW, [sign(RAW)], SECRET), true);
      assert.equal(verifyWebhookSignature(RAW, [sign(RAW), "sha256=bogus"], SECRET), true);
      assert.equal(verifyWebhookSignature(RAW, ["sha256=bogus", sign(RAW)], SECRET), false);
      assert.equal(verifyWebhookSignature(RAW, [], SECRET), false);
    },
  },

  // --- INSTALLATION_ACTIONS ---------------------------------------------
  {
    name: "INSTALLATION_ACTIONS holds the handled installation lifecycle set",
    run: () => {
      assert.deepEqual(
        [...INSTALLATION_ACTIONS].sort(),
        [
          "created",
          "deleted",
          "new_permissions_accepted",
          "suspend",
          "unsuspend",
        ],
      );
      for (const action of INSTALLATION_ACTIONS) assert.equal(typeof action, "string");
      // Repo-scoped events are acked, never acted on.
      assert.equal(INSTALLATION_ACTIONS.has("installation_repositories"), false);
      assert.equal(INSTALLATION_ACTIONS.has("ping"), false);
    },
  },
];

async function main(): Promise<void> {
  let failed = 0;
  for (const c of checks) {
    try {
      await c.run();
      console.log(`ok - ${c.name}`);
    } catch (err) {
      failed += 1;
      console.error(`FAIL - ${c.name}: ${(err as Error).message}`);
    }
  }
  if (failed > 0) {
    console.error(`${failed}/${checks.length} webhook util checks failed`);
    process.exitCode = 1;
  } else {
    console.log(`${checks.length}/${checks.length} webhook util checks passed`);
  }
}

void main().catch((err: unknown) => {
  console.error(`webhook util checks failed to run: ${(err as Error).message}`);
  process.exit(1);
});
