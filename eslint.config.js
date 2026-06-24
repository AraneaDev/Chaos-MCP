import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';
import prettierConfig from 'eslint-config-prettier';
import vitest from 'eslint-plugin-vitest';

export default tseslint.config(
  eslint.configs.recommended,
  ...tseslint.configs.strict,
  ...tseslint.configs.stylistic,
  // ─── Test conventions ───────────────────────────────────────────────────
  // eslint-plugin-vitest registered with its recommended rules plus the
  // two tightening rules we explicitly want to enforce going forward.
  vitest.configs.recommended,
  prettierConfig,
  {
    languageOptions: {
      parserOptions: {
        project: 'tsconfig.eslint.json',
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // Allow unused vars prefixed with underscore (common pattern for intentionally unused params)
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],

      // Enforce `it` over `test` consistently within describe blocks.
      // `vitest/consistent-test-it` defaults to disallowing the bare `test` function
      // when an `it` alias is available; we keep defaults and add explicit options
      // so future contributors can see the policy at the call site.
      'vitest/consistent-test-it': ['error', { fn: 'it', withinDescribe: 'it' }],

      // Forbid conditional expectations (`if (x) { expect(...) }`). Forces tests
      // to be unambiguous: either always assert or split into two explicit cases.
      // (Existing tests that violate this rule are fixed in this round.)
      'vitest/no-conditional-expect': 'error',
    },
  },
  {
    ignores: ['build/', 'node_modules/', 'coverage/', 'vitest.config.ts', 'eslint.config.js'],
  },
);
