import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';
import prettierConfig from 'eslint-config-prettier';
import vitest from '@vitest/eslint-plugin';

export default tseslint.config(
  eslint.configs.recommended,
  ...tseslint.configs.strict,
  ...tseslint.configs.stylistic,
  // ─── Test conventions ───────────────────────────────────────────────────
  // @vitest/eslint-plugin registered with its recommended rules plus the two
  // tightening rules we explicitly want to enforce going forward. (This is the
  // maintained successor to eslint-plugin-vitest, which stopped at 0.5.4 and
  // predates vitest 4; the rule namespace stays `vitest/`.)
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

      // The e2e suites gate heavy cases behind an env flag by aliasing the test
      // function (`const it_heavy = enabled ? it : it.skip`), which is how they
      // skip loudly instead of silently. The rule cannot see through an alias,
      // so it has to be told these are test blocks — otherwise every assertion
      // inside one reads as a standalone expect.
      'vitest/no-standalone-expect': [
        'error',
        { additionalTestBlockFunctions: ['it_heavy', 'it_canary', 'it_e2e'] },
      ],
    },
  },
  {
    ignores: ['build/', 'node_modules/', 'coverage/', 'vitest.config.ts', 'eslint.config.js'],
  },
);
