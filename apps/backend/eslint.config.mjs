// Backend eslint flat config — bans console.* in src (use AppLogger instead).
// AppLogger itself goes through Nest Logger, so no exceptions are needed.
export default [
  {
    files: ['src/**/*.ts'],
    rules: {
      'no-console': 'error',
    },
  },
];
