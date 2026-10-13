// Backend eslint flat config — bans console.* in runtime sources
// (use AppLogger from src/common/app-logger.service.ts instead).
// AppLogger itself goes through Nest Logger, so no exceptions are needed.
//
// Test reporters (*.spec.ts / *.e2e.ts / *.test.ts) are excluded: console
// there is the test reporter, not runtime logging. Existing
// `eslint-disable-next-line no-console` comments in spec files are
// therefore harmless (kept, not cleaned up) — they apply to a rule that
// is already off for those files.
//
// Only TS parsing is configured (no type-aware rules, no projectService)
// to keep lint fast: the core `no-console` rule is enough.
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    files: ['src/**/*.ts'],
    extends: [tseslint.configs.base],
    rules: {
      'no-console': 'error',
    },
  },
  {
    files: ['**/*.spec.ts', '**/*.e2e.ts', '**/*.test.ts'],
    rules: {
      'no-console': 'off',
    },
  },
);
