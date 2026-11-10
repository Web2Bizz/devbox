/**
 * SkillLoader unit checks — self-contained runner (plain node:assert).
 *
 * Runs against COMPILED dist (same constraint as the other runners):
 *   `bun run build && bun dist/processes/modules/workers/modules/skills/__tests__/skills-loader.spec.js`
 * Also executes under `bun test dist` (top-level, throws on failure).
 *
 * Uses a throwaway git repository (mkdtemp + git init/commit, removed in
 * `finally`) to prove the pinning contract:
 * - SKILL.md is read at the pinned commit and lands in the system prompt with
 *   the `read` effect;
 * - a `scripts/` directory upgrades the skill to `write-local`;
 * - editing SKILL.md in the working tree does NOT leak into a run pinned to an
 *   older sha (and a non-sha ref is rejected outright);
 * - allowed-tools is deny-by-default and filters the ToolView surface;
 * - malformed frontmatter / oversized names throw.
 */
import 'reflect-metadata';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { ToolView } from '@rush-code/contracts';
import type { AppLogger } from '@common/logger';
import { parseFrontmatter } from '../frontmatter';
import { ForbiddenToolError, type LoadedSkill, type SkillBundle } from '../skill.types';
import { SkillLoader } from '../skills-loader.service';

const logger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
} as unknown as AppLogger;

const loader = new SkillLoader(logger);

const SKILL_MD = `---
name: demo
description: Demo skill for the loader spec.
allowed-tools:
  - native:git.recon
---

Activate the demo instructions.
`;

const SKILL_MD_NO_TOOLS = `---
name: demo-no-tools
description: A skill without allowed-tools denies every tool.
---

Body only.
`;

const VIEWS: Array<ToolView> = [
  {
    id: 'native:git.recon',
    title: 'Git recon',
    description: 'Read HEAD and dirty files.',
    inputSchema: { type: 'object' },
  },
  {
    id: 'native:fs.write',
    title: 'Write file',
    description: 'Write a file.',
    inputSchema: { type: 'object' },
  },
];

function git(cwd: string, args: Array<string>): string {
  return String(execFileSync('git', args, { cwd, encoding: 'utf8' })).trim();
}

function initRepo(root: string): void {
  mkdirSync(root, { recursive: true });
  git(root, ['init', '-b', 'main']);
  git(root, ['config', 'user.email', 'skills-spec@localhost']);
  git(root, ['config', 'user.name', 'skills-spec']);
}

function commitAll(root: string, message: string): string {
  git(root, ['add', '-A']);
  git(root, ['commit', '-m', message]);
  return git(root, ['rev-parse', 'HEAD']);
}

/** Builds the bundle a skill with no allowed-tools produces (deny-by-default). */
function bundleFor(skill: LoadedSkill): SkillBundle {
  return {
    skills: [skill],
    system: '',
    allowedTools: new Set(skill.meta.allowedTools),
    effects: skill.effects,
  };
}

const checks: Array<{ name: string; run: () => Promise<void> | void }> = [
  {
    name: 'pinned SKILL.md is loaded, body in system, effect read',
    run: async () => {
      const root = mkdtempSync(path.join(tmpdir(), 'skills-loader-read-'));
      try {
        initRepo(root);
        const dir = path.join(root, 'skills', 'demo');
        mkdirSync(dir, { recursive: true });
        writeFileSync(path.join(dir, 'SKILL.md'), SKILL_MD, 'utf8');
        const sha = commitAll(root, 'add demo skill');

        const bundle = await loader.loadForRun(root, sha);
        assert.equal(bundle.skills.length, 1);
        assert.equal(bundle.skills[0]?.meta.name, 'demo');
        assert.ok(bundle.system.includes('Activate the demo instructions.'));
        assert.deepEqual(bundle.effects, ['read']);
        assert.deepEqual([...bundle.allowedTools], ['native:git.recon']);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
  },
  {
    name: 'scripts/ in the pinned tree upgrades the effect to write-local',
    run: async () => {
      const root = mkdtempSync(path.join(tmpdir(), 'skills-loader-scripts-'));
      try {
        initRepo(root);
        const dir = path.join(root, 'skills', 'demo');
        mkdirSync(path.join(dir, 'scripts'), { recursive: true });
        writeFileSync(path.join(dir, 'SKILL.md'), SKILL_MD, 'utf8');
        writeFileSync(path.join(dir, 'scripts', 'run.sh'), '#!/bin/sh\nexit 0\n', 'utf8');
        const sha = commitAll(root, 'add demo skill with scripts');

        const bundle = await loader.loadForRun(root, sha);
        assert.deepEqual([...bundle.effects].sort(), ['read', 'write-local']);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
  },
  {
    name: 'pinning: uncommitted SKILL.md edit never reaches an older sha',
    run: async () => {
      const root = mkdtempSync(path.join(tmpdir(), 'skills-loader-pin-'));
      try {
        initRepo(root);
        const dir = path.join(root, 'skills', 'demo');
        mkdirSync(dir, { recursive: true });
        writeFileSync(path.join(dir, 'SKILL.md'), SKILL_MD, 'utf8');
        const sha = commitAll(root, 'add demo skill');

        // Working-tree-only edit: the fresher text must be invisible to a run
        // pinned at `sha` (git show reads the object, not the checkout).
        writeFileSync(
          path.join(dir, 'SKILL.md'),
          SKILL_MD.replace('Activate the demo instructions.', 'FRESH UNSAFE TEXT'),
          'utf8',
        );

        const bundle = await loader.loadForRun(root, sha);
        assert.ok(bundle.system.includes('Activate the demo instructions.'));
        assert.ok(!bundle.system.includes('FRESH UNSAFE TEXT'));

        await assert.rejects(
          () => loader.loadForRun(root, 'HEAD'),
          /definitionSetHash must pin a commit sha/,
        );
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
  },
  {
    name: 'deny-by-default: a skill without allowed-tools yields no tools',
    run: () => {
      const skill = loader.parseSkill(SKILL_MD_NO_TOOLS);
      const bundle = bundleFor(skill);
      assert.deepEqual(loader.filterToolViews(VIEWS, bundle), []);
      assert.throws(
        () => loader.assertAllowedTool(bundle, 'native:git.recon'),
        ForbiddenToolError,
      );
    },
  },
  {
    name: 'allow-list keeps only the allowed ToolView',
    run: () => {
      const bundle = bundleFor(loader.parseSkill(SKILL_MD));
      const filtered = loader.filterToolViews(VIEWS, bundle);
      assert.deepEqual(
        filtered.map((view) => view.id),
        ['native:git.recon'],
      );
      assert.doesNotThrow(() => loader.assertAllowedTool(bundle, 'native:git.recon'));
    },
  },
  {
    name: 'no skills → tool surface untouched and assert is a no-op',
    run: () => {
      const bundle: SkillBundle = {
        skills: [],
        system: '',
        allowedTools: new Set<string>(),
        effects: [],
      };
      assert.deepEqual(
        loader.filterToolViews(VIEWS, bundle).map((view) => view.id),
        VIEWS.map((view) => view.id),
      );
      assert.doesNotThrow(() => loader.assertAllowedTool(bundle, 'native:fs.write'));
    },
  },
  {
    name: 'frontmatter: missing --- throws, oversized name throws',
    run: () => {
      assert.throws(
        () => parseFrontmatter('# no frontmatter here\n'),
        /SKILL.md must start with frontmatter/,
      );
      const longName = 'a'.repeat(65);
      assert.throws(
        () =>
          loader.parseSkill(`---\nname: ${longName}\ndescription: too long name\n---\n\nbody\n`),
        /skill name must be a slug of 1-64 chars/,
      );
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
    console.error(`${failed}/${checks.length} skills loader checks failed`);
    process.exitCode = 1;
    throw new Error(`${failed}/${checks.length} skills loader checks failed`);
  }
  console.log(`${checks.length}/${checks.length} skills loader checks passed`);
}

void main().catch((err: unknown) => {
  console.error(`skills loader checks failed to run: ${(err as Error).message}`);
  process.exit(1);
});
