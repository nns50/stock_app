import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import reactHooks from 'eslint-plugin-react-hooks';
import prettier from 'eslint-config-prettier';

export default tseslint.config(
  {
    ignores: [
      '**/dist/**',
      '**/node_modules/**',
      '**/coverage/**',
      '**/*.config.js',
      '**/*.config.mjs',
      '**/*.config.ts',
      'server/data/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    // Pragmatic rules: the codebase intentionally uses `any` for mapping vendor
    // API responses and `console` for server logging.
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      'no-console': 'off',
      'no-empty': ['error', { allowEmptyCatch: true }],
      '@typescript-eslint/no-unused-vars': [
        'warn',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrors: 'none' },
      ],
    },
  },
  {
    // Server source only: a floating promise is PROCESS-FATAL on modern Node
    // (an unhandled rejection kills the server), so every async call must be
    // awaited, returned, `.catch`ed, or explicitly `void`ed with a guarded
    // body. Type-aware and scoped to server/src — the browser doesn't die
    // from one, and tests run under vitest's own rejection tracking.
    files: ['server/src/**/*.ts'],
    languageOptions: {
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname + '/server' },
    },
    rules: {
      '@typescript-eslint/no-floating-promises': 'error',
    },
  },
  {
    // Plain browser scripts served verbatim from web/public (no bundler, no
    // TS — e.g. theme-init.js): declare the DOM globals that TS files get
    // from lib.dom, since js.configs.recommended's no-undef knows none.
    files: ['web/public/**/*.js'],
    languageOptions: {
      globals: { window: 'readonly', document: 'readonly', localStorage: 'readonly' },
    },
  },
  {
    // React hooks correctness for the frontend.
    files: ['web/**/*.{ts,tsx}'],
    plugins: { 'react-hooks': reactHooks },
    rules: {
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'warn',
    },
  },
  {
    // Web source gets the same floating-promise discipline as the server —
    // the browser doesn't crash, but every unawaited rejection is a silently
    // broken UI state (a page that just sits empty) plus a console error
    // nobody is watching for. Excludes tests: vitest tracks rejections.
    files: ['web/src/**/*.{ts,tsx}'],
    ignores: ['web/src/**/*.test.{ts,tsx}', 'web/src/test/**'],
    languageOptions: {
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname + '/web' },
    },
    rules: {
      '@typescript-eslint/no-floating-promises': 'error',
    },
  },
  prettier,
);
