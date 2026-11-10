/**
 * Tool jail util checks — self-contained runner (plain node:assert, no deps).
 *
 * Runs against COMPILED dist:
 *   `bun run build && bun dist/processes/modules/ai/modules/tools/utils/tool-jail/__tests__/tool-jail.spec.js`
 * Also executes under `bun run test` (dist/*.spec.js).
 *
 * Covers the jail contract the tools rely on: absolute paths, `..` escapes,
 * NUL bytes and empty input are rejected before any fs call; a nested relative
 * path resolves inside the jail; `relativeToolPath` answers a posix relative
 * path and `.` for the root itself. `WorkspacePathService` is stubbed
 * structurally — only `assertInsideJail` is reached, no fs/realpath needed.
 */
import assert from "node:assert/strict";
import path from "node:path";
import type { WorkspacePathService } from "@common/storage/workspace-path.service";
import { relativeToolPath, resolveToolPath } from "../tool-jail.util";

/** Jail stub: `assertInsideJail` accepts the target unchanged (no fs). */
function stubPaths(): WorkspacePathService {
  return {
    assertInsideJail: async (absolutePath: string): Promise<string> => absolutePath,
  } as unknown as WorkspacePathService;
}

type Check = { name: string; run: () => Promise<void> };

const DIRECTORY = "/repos/orgs/org/projects/project/content";

const checks: Array<Check> = [
  {
    name: "rejects an absolute path",
    run: async () => {
      await assert.rejects(() => resolveToolPath(stubPaths(), DIRECTORY, "/etc/passwd"), /escapes the project/);
    },
  },
  {
    name: "rejects a .. escape",
    run: async () => {
      await assert.rejects(() => resolveToolPath(stubPaths(), DIRECTORY, "../outside.txt"), /escapes the project/);
      await assert.rejects(() => resolveToolPath(stubPaths(), DIRECTORY, "src/../../outside.txt"), /escapes the project/);
    },
  },
  {
    name: "rejects a NUL byte",
    run: async () => {
      await assert.rejects(() => resolveToolPath(stubPaths(), DIRECTORY, "src/a\0b.ts"), /escapes the project/);
    },
  },
  {
    name: "rejects empty input",
    run: async () => {
      await assert.rejects(() => resolveToolPath(stubPaths(), DIRECTORY, ""), /path is empty/);
      await assert.rejects(() => resolveToolPath(stubPaths(), DIRECTORY, "   "), /path is empty/);
    },
  },
  {
    name: "accepts a nested relative path",
    run: async () => {
      const resolved: string = await resolveToolPath(stubPaths(), DIRECTORY, "src/nested/a.ts");
      assert.equal(resolved, path.join(DIRECTORY, "src/nested/a.ts"));
    },
  },
  {
    name: "relativeToolPath answers posix relative, . for the same path",
    run: async () => {
      assert.equal(relativeToolPath(DIRECTORY, path.join(DIRECTORY, "src/nested/a.ts")), "src/nested/a.ts");
      assert.equal(relativeToolPath(DIRECTORY, DIRECTORY), ".");
    },
  },
];

async function main(): Promise<void> {
  let failed = 0;
  for (const check of checks) {
    try {
      await check.run();
      console.log(`ok - ${check.name}`);
    } catch (error) {
      failed += 1;
      console.error(`FAIL - ${check.name}: ${(error as Error).message}`);
    }
  }
  if (failed > 0) {
    console.error(`${failed}/${checks.length} tool-jail checks failed`);
    process.exitCode = 1;
    throw new Error(`${failed}/${checks.length} tool-jail checks failed`);
  }
  console.log(`${checks.length}/${checks.length} tool-jail checks passed`);
}

void main().catch((error: unknown) => {
  console.error(`tool-jail checks failed to run: ${(error as Error).message}`);
  process.exit(1);
});
