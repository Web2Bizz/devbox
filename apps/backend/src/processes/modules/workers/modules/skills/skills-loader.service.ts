import { Injectable } from '@nestjs/common';
import { execFile } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';
import type { ToolView } from '@rush-code/contracts';
import { AppLogger, serializeCause } from '@common/logger';
import { parseFrontmatter } from './frontmatter';
import {
  ForbiddenToolError,
  type LoadedSkill,
  type SkillBundle,
  type SkillEffect,
} from './skill.types';

/** Promisified `execFile` narrowed to the call shape this service uses. */
type ExecFileAsync = (
  file: string,
  args: ReadonlyArray<string>,
  options?: { cwd?: string; timeout?: number; maxBuffer?: number },
) => Promise<{ stdout: string; stderr: string }>;

const execFileAsync: ExecFileAsync = promisify(execFile);

/** Hard limits of one skill definition (metadata stays cheap, body bounded). */
const MAX_NAME: number = 64;
const MAX_DESCRIPTION: number = 1024;
/** ~4 chars per token — the same rough estimate the rest of the harness uses. */
const MAX_BODY_TOKENS: number = 5000;
const SKILLS_DIR: string = 'skills';

const SKILL_NAME_PATTERN: RegExp = /^[a-z0-9][a-z0-9-]*$/;
const COMMIT_SHA_PATTERN: RegExp = /^[0-9a-f]{7,40}$/i;

const GIT_TIMEOUT_MS: number = 5000;
const GIT_MAX_BUFFER: number = 1024 * 1024;

/**
 * SkillLoader — repository skills, pinned by the run's definition set.
 *
 * Progressive disclosure has two phases here:
 * 1. discovery — `git ls-tree` at the pinned commit + frontmatter only
 *    (name/description/allowed-tools), which is what decides the tool
 *    allow-list and the effect class;
 * 2. activation — the body is read with `git show <sha>:skills/<n>/SKILL.md`
 *    and only then attached to the step's system prompt.
 *
 * The pinning rule is absolute: every read goes through `commit_sha` taken from
 * `definitionSetHash` (`sha256:<sha>`), never through the working tree. Editing
 * SKILL.md while a run is in flight therefore cannot change that run — the next
 * run at a new baseCommit simply pins a new definition set. A skill that is
 * absent at the pinned commit is skipped with a warn (not a run failure); a
 * malformed skill is a real definition error and fails the step.
 *
 * allowed-tools is deny-by-default: any active skill replaces the tool surface
 * with the union of its `allowed-tools`, and a skill without them yields no
 * tools at all. The model only ever sees the filtered ToolView projection.
 */
@Injectable()
export class SkillLoader {
  constructor(private readonly logger: AppLogger = new AppLogger(SkillLoader.name)) {}

  /** Parses one SKILL.md (metadata validation + body budget + read effect). */
  parseSkill(raw: string): LoadedSkill {
    const { meta, body }: { meta: Record<string, unknown>; body: string } =
      parseFrontmatter(raw);

    const name: string = typeof meta.name === 'string' ? meta.name.trim() : '';
    if (name.length === 0 || name.length > MAX_NAME || !SKILL_NAME_PATTERN.test(name)) {
      throw new Error('skill name must be a slug of 1-64 chars');
    }

    if (typeof meta.description !== 'string') {
      throw new Error('skill description is required');
    }
    const description: string = meta.description.trim();
    if (description.length > MAX_DESCRIPTION) {
      throw new Error('skill description exceeds 1024 chars');
    }

    const allowedTools: ReadonlyArray<string> = this.parseAllowedTools(meta.allowedTools);
    if (body.length / 4 > MAX_BODY_TOKENS) {
      throw new Error('skill body exceeds 5000 token budget');
    }

    // Pure instructions are read-only; `loadForRun` upgrades to write-local
    // when the pinned tree also ships a `scripts/` directory.
    return {
      meta: { name, description, allowedTools },
      body,
      effects: ['read'],
    };
  }

  /**
   * Resolves every skill of the commit pinned by `definitionSetHash`.
   *
   * `commitSha` must be a real sha (never a ref): a moving ref would defeat the
   * pinning guarantee the journal records as `definitionSetHash`.
   */
  async loadForRun(
    repositoryDirectory: string,
    commitSha: string,
    baseSystem: string = '',
  ): Promise<SkillBundle> {
    if (!COMMIT_SHA_PATTERN.test(commitSha)) {
      throw new Error('definitionSetHash must pin a commit sha');
    }

    const listing: string = await this.git(repositoryDirectory, [
      'ls-tree',
      '--name-only',
      `${commitSha}:${SKILLS_DIR}`,
    ]).catch(() => '');
    const entries: Array<string> = listing
      .split('\n')
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0);

    if (entries.length === 0) {
      // No skills pinned at this commit is a valid definition set, not an error.
      return { skills: [], system: baseSystem, allowedTools: new Set<string>(), effects: [] };
    }

    const skills: Array<LoadedSkill> = [];
    for (const entry of entries) {
      const name: string = path.basename(entry);
      if (!SKILL_NAME_PATTERN.test(name)) {
        this.logger.warn(`[workers] skill skipped name=${name}`, '');
        continue;
      }

      const raw: string | null = await this.git(repositoryDirectory, [
        'show',
        `${commitSha}:${SKILLS_DIR}/${name}/SKILL.md`,
      ]).catch((error: unknown) => {
        // A skill directory without SKILL.md must not take the run down.
        this.logger.warn(`[workers] skill skipped name=${name}`, '');
        this.logger.debug(serializeCause(error), '');
        return null;
      });
      if (raw === null) continue;

      const skill: LoadedSkill = this.parseSkill(raw);
      const scripts: string = await this.git(repositoryDirectory, [
        'ls-tree',
        '--name-only',
        `${commitSha}:${SKILLS_DIR}/${name}/scripts`,
      ]).catch(() => '');
      const effects: ReadonlyArray<SkillEffect> =
        scripts.length > 0 ? ['read', 'write-local'] : skill.effects;
      skills.push({ meta: skill.meta, body: skill.body, effects });
    }

    const allowedTools: Set<string> = new Set<string>();
    const effects: Set<SkillEffect> = new Set<SkillEffect>();
    for (const skill of skills) {
      for (const toolId of skill.meta.allowedTools) allowedTools.add(toolId);
      for (const effect of skill.effects) effects.add(effect);
    }

    this.logger.debug(`[workers] skills loaded count=${skills.length}`, '');
    return {
      skills,
      system: this.buildSystemPrompt(baseSystem, skills),
      allowedTools,
      effects: Array.from(effects),
    };
  }

  /** Base system prompt + one `<skill>` block per activated skill. */
  buildSystemPrompt(base: string, skills: ReadonlyArray<LoadedSkill>): string {
    return [
      base,
      ...skills.map((skill) => `<skill name="${skill.meta.name}">\n${skill.body}\n</skill>`),
    ]
      .filter(Boolean)
      .join('\n\n');
  }

  /**
   * Model-facing tool surface: no skills → tools untouched; skills without
   * allowed-tools → deny by default (empty surface).
   */
  filterToolViews(views: ReadonlyArray<ToolView>, bundle: SkillBundle): Array<ToolView> {
    if (bundle.skills.length === 0) return [...views];
    if (bundle.allowedTools.size === 0) return [];
    return views.filter((view) => bundle.allowedTools.has(view.id));
  }

  /** Explicit invocation gate: a tool outside the pinned allow-list is forbidden. */
  assertAllowedTool(bundle: SkillBundle, toolId: string): void {
    if (bundle.skills.length > 0 && !bundle.allowedTools.has(toolId)) {
      throw new ForbiddenToolError(bundle.skills[0].meta.name, toolId);
    }
  }

  /** One git invocation (execFile, no shell, bounded output) → trimmed stdout. */
  private async git(repositoryDirectory: string, args: Array<string>): Promise<string> {
    // Destructuring an upstream exec result — explicit annotation cannot be expressed here.
    const { stdout } = await execFileAsync('git', args, {
      cwd: repositoryDirectory,
      timeout: GIT_TIMEOUT_MS,
      maxBuffer: GIT_MAX_BUFFER,
    });
    return stdout.trim();
  }

  private parseAllowedTools(value: unknown): ReadonlyArray<string> {
    if (value === undefined) return [];
    if (!Array.isArray(value)) {
      throw new Error('skill allowed-tools must be a list');
    }
    const tools: Array<string> = [];
    for (const entry of value) {
      if (typeof entry !== 'string' || entry.trim().length === 0) {
        throw new Error('skill allowed-tools entries must be non-empty strings');
      }
      tools.push(entry.trim());
    }
    return tools;
  }
}
