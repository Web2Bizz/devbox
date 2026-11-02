import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { BadRequestException } from "@nestjs/common";
import type { GithubAppService } from "../github-app.service";
import type { GithubBindingService } from "../github-binding.service";
import type { GithubInstallationsService } from "../github-installations.service";
import type { GithubService } from "../github.service";
import { GithubController } from "../github.controller";
import type { InstallationWebhookPayload } from "../utils/webhook";

process.env.APP_BACKEND_PORT ??= "3000";
const WEBHOOK_SECRET = "whsec_webhook_raw_body_spec_not_real";
process.env.GITHUB_WEBHOOK_SECRET = WEBHOOK_SECRET;

type Case = { name: string; run: () => Promise<void> | void };

const cases: Case[] = [];
let currentSuite = "";

function describe(name: string, fn: () => void): void {
  currentSuite = name;
  fn();
  currentSuite = "";
}

function it(name: string, run: () => Promise<void> | void): void {
  cases.push({ name: currentSuite ? `${currentSuite} :: ${name}` : name, run });
}

type UpsertCall = { input: Record<string, unknown>; correlationId?: string };

function controller() {
  const upserts: Array<UpsertCall> = [];
  const removals: Array<number> = [];
  const installations = {
    async upsert(input: Record<string, unknown>, correlationId?: string) {
      upserts.push({ input, correlationId });
      return input;
    },
    async removeByInstallationId(installationId: number) {
      removals.push(installationId);
    },
  };
  const ctl = new GithubController(
    {} as unknown as GithubService,
    {} as unknown as GithubAppService,
    installations as unknown as GithubInstallationsService,
    {} as unknown as GithubBindingService,
  );
  return { ctl, upserts, removals };
}

function createdPayload(): InstallationWebhookPayload {
  return {
    action: "created",
    installation: {
      id: 111,
      account: { login: "acme", type: "Organization" },
    },
  };
}

function sign(raw: Buffer | string): string {
  const body = typeof raw === "string" ? Buffer.from(raw, "utf8") : raw;
  return `sha256=${createHmac("sha256", WEBHOOK_SECRET).update(body).digest("hex")}`;
}

function isRawBodyRequired(err: unknown): boolean {
  assert.ok(
    err instanceof BadRequestException,
    `expected BadRequestException, got ${String(err)}`,
  );
  assert.equal(err.getStatus(), 400);
  const body = err.getResponse() as { code?: string };
  assert.equal(body.code, "WEBHOOK_RAW_BODY_REQUIRED");
  return true;
}

describe("GithubController webhook raw body", () => {
  it("rejects a webhook without a raw body (400 WEBHOOK_RAW_BODY_REQUIRED) and writes nothing", async () => {
    const { ctl, upserts, removals } = controller();
    await assert.rejects(
      () => ctl.webhook(createdPayload(), {}, undefined, "installation"),
      isRawBodyRequired,
    );
    assert.deepEqual(upserts, []);
    assert.deepEqual(removals, []);
  });

  it("rejects a webhook whose re-serialized JSON carries a valid signature when the raw body is absent", async () => {
    const { ctl, upserts, removals } = controller();
    const body = createdPayload();
    const signatureOverReserializedJson = sign(JSON.stringify(body));
    await assert.rejects(
      () =>
        ctl.webhook(
          body,
          {},
          signatureOverReserializedJson,
          "installation",
          "cid-raw-missing",
        ),
      isRawBodyRequired,
    );
    assert.deepEqual(upserts, []);
    assert.deepEqual(removals, []);
  });

  it("rejects a non-object request without a raw body as WEBHOOK_RAW_BODY_REQUIRED", async () => {
    const { ctl, upserts, removals } = controller();
    await assert.rejects(
      () => ctl.webhook(createdPayload(), null, undefined, "installation"),
      isRawBodyRequired,
    );
    assert.deepEqual(upserts, []);
    assert.deepEqual(removals, []);
  });

  it("accepts an installation event whose signature matches the captured raw body", async () => {
    const { ctl, upserts, removals } = controller();
    const body = createdPayload();
    const raw = Buffer.from(JSON.stringify(body), "utf8");
    const result = await ctl.webhook(
      body,
      { rawBody: raw },
      sign(raw),
      "installation",
      "cid-raw-present",
    );
    assert.deepEqual(result, { ok: true });
    assert.equal(upserts.length, 1);
    assert.equal(upserts[0].input.installationId, 111);
    assert.deepEqual(removals, []);
  });
});

async function main(): Promise<void> {
  let failed = 0;
  for (const c of cases) {
    try {
      await c.run();
      console.log(`ok   - ${c.name}`);
    } catch (err) {
      failed += 1;
      console.error(`FAIL - ${c.name}: ${(err as Error).message}`);
    }
  }
  console.log(`\n${cases.length - failed}/${cases.length} checks passed`);
  if (failed > 0) process.exitCode = 1;
}

void main().catch((err: unknown) => {
  console.error(`github webhook raw body checks failed to run: ${(err as Error).message}`);
  process.exit(1);
});
