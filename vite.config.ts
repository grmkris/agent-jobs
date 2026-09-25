import { defineConfig } from 'vite-plus'

/**
 * Repo-wide toolchain config: the lint ruleset `vp lint` reads. Per-package tasks live in each
 * package's own `vite.config.ts`. The ruleset is the cloudflare-os one minus its repo-specific rules.
 */
export default defineConfig({
  check: {
    fmt: false,
  },
  lint: {
    // Foundry dependencies are git submodules with their own JS tooling; not ours to lint.
    ignorePatterns: ['contracts/lib/**', 'contracts/out/**', 'contracts/cache/**'],
    categories: {
      correctness: 'error',
      suspicious: 'error',
    },
    plugins: ['typescript', 'unicorn', 'oxc', 'import'],
    options: {
      // Type-aware rules are a separate decision: `no-floating-promises` clashes with Effect's
      // deliberately-unawaited style in places, and every run would add a tsgo pass.
      typeAware: false,
    },
    env: {
      es2024: true,
    },
    rules: {
      'import/no-unassigned-import': 'off',
      'no-underscore-dangle': 'off',
      'no-unused-vars': [
        'error',
        {
          args: 'none',
          caughtErrors: 'none',
          varsIgnorePattern: '^_',
          ignoreRestSiblings: true,
        },
      ],
    },
  },
})
