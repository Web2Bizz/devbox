/** Effect class a skill claims for its instructions (union over the bundle). */
export type SkillEffect = 'read' | 'write-local';

/** Cheap discovery metadata of one SKILL.md (no body — progressive disclosure). */
export type SkillMeta = {
  name: string;
  description: string;
  allowedTools: ReadonlyArray<string>;
};

/** One skill as pinned by the run's definition set (metadata + activated body). */
export type LoadedSkill = {
  meta: SkillMeta;
  body: string;
  effects: ReadonlyArray<SkillEffect>;
};

/**
 * Everything one run step needs from the pinned definition set: the resolved
 * system prompt, the tool allow-list and the union of declared effects.
 */
export type SkillBundle = {
  skills: ReadonlyArray<LoadedSkill>;
  system: string;
  allowedTools: ReadonlySet<string>;
  effects: ReadonlyArray<SkillEffect>;
};

/** Raised when a step tries to use a tool the active skills did not allow. */
export class ForbiddenToolError extends Error {
  constructor(skill: string, toolId: string) {
    super(`skill ${skill} forbids tool ${toolId}`);
    this.name = 'ForbiddenToolError';
  }
}
