/**
 * organization-member util checks — self-contained runner (plain
 * node:assert, no deps).
 *
 * Runs against COMPILED dist:
 *   `bun run build && bun dist/organizations/utils/organization-member/__tests__/organization-member.spec.js`
 * Also executes under `bun test dist` (top-level run, throws on failure).
 *
 * Covers the row → wire codec: orgId/userId/role are carried over and the
 * `createdAt` Date becomes an ISO-8601 string (no live Postgres).
 */
import assert from "node:assert/strict";
import type { OrganizationMemberRow } from "../../../../common/db/schema";
import { toMember } from "../organization-member.util";

const createdAt = new Date("2026-10-20T00:00:00.000Z");

function row(overrides: Partial<OrganizationMemberRow> = {}): OrganizationMemberRow {
  return {
    id: "123e4567-e89b-12d3-a456-426614174000",
    orgId: "123e4567-e89b-12d3-a456-426614174005",
    userId: "123e4567-e89b-12d3-a456-426614174001",
    role: "user",
    createdAt,
    updatedAt: createdAt,
    ...overrides,
  };
}

const checks: Array<{ name: string; run: () => Promise<void> | void }> = [
  {
    name: "toMember maps orgId/userId/role and stringifies createdAt (ISO-8601)",
    run: () => {
      const member = toMember(row());
      assert.equal(member.orgId, "123e4567-e89b-12d3-a456-426614174005");
      assert.equal(member.userId, "123e4567-e89b-12d3-a456-426614174001");
      assert.equal(member.role, "user");
      assert.equal(member.createdAt, "2026-10-20T00:00:00.000Z");
      assert.equal(typeof member.createdAt, "string");
    },
  },
  {
    name: "toMember narrows the maintainer role",
    run: () => {
      const member = toMember(row({ role: "maintainer" }));
      assert.equal(member.role, "maintainer");
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
    console.error(`${failed}/${checks.length} organization-member checks failed`);
    process.exitCode = 1;
    throw new Error(`${failed}/${checks.length} organization-member checks failed`);
  } else {
    console.log(`${checks.length}/${checks.length} organization-member checks passed`);
  }
}

void main().catch((err: unknown) => {
  console.error(`organization-member checks failed to run: ${(err as Error).message}`);
  process.exit(1);
});
