/**
 * commitlint config — Conventional Commits for @web2bizz/ui.
 *
 * Synced with `.opencode/skills/commit/SKILL.md` (§ «Формат сообщений»):
 *   - canonical skill types: `feat`, `fix`, `docs`, `refactor`, `chore`,
 *     `test` (+ `init` for repository init only, `!` for breaking changes);
 *   - repo extensions actually used in this history: `build`, `bump`, `ci`,
 *     `debug` (the skill lists types "as in that pack's history", this repo
 *     additionally gates CI/build/bump/debug commits, incl. release bumps);
 *   - subject: lowercase, imperative, no trailing period (base config);
 *   - `Trello:` / `Closes:` trailers stay by-convention per the skill
 *     (not lintable — only the author knows if a commit closes a task);
 *   - `Merge ...` and `Revert "..."` commits bypass lint (git-generated
 *     messages that do not follow the conventional format).
 *
 * Enforced locally via husky (.husky/commit-msg).
 */
export default {
  extends: ["@commitlint/config-conventional"],
  ignores: [(message) => message.startsWith("Merge ") || message.startsWith("Revert ")],
  rules: {
    "type-enum": [
      2,
      "always",
      [
        "build",
        "bump",
        "chore",
        "ci",
        "debug",
        "docs",
        "feat",
        "fix",
        "init",
        "perf",
        "refactor",
        "revert",
        "style",
        "test",
      ],
    ],
  },
};
