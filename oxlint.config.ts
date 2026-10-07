import { defineConfig } from 'oxlint'

export default defineConfig({
  ignorePatterns: ['contracts/lib/**', 'contracts/out/**', 'contracts/cache/**', 'apps/docs/dist/**', 'apps/docs/.output/**', 'apps/docs/.nitro/**', 'apps/docs/.tanstack/**', 'apps/docs/.source/**', 'apps/docs/src/routeTree.gen.ts'],
  categories: { correctness: 'error', suspicious: 'error' },
  plugins: ['typescript', 'unicorn', 'oxc', 'import'],
  options: { typeAware: false },
  env: { es2024: true },
  rules: {
    'import/no-unassigned-import': 'off',
    'no-underscore-dangle': 'off',
    'no-unused-vars': ['error', { args: 'none', caughtErrors: 'none', varsIgnorePattern: '^_', ignoreRestSiblings: true }],
  },
})
