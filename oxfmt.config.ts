import { defineConfig } from 'oxfmt'

export default defineConfig({
  singleQuote: true,
  semi: false,
  printWidth: 120,
  ignorePatterns: [
    'contracts/**',
    'docs/**',
    'skill/**',
    'scripts/mining/README.md',
    '**/generated/**',
    'packages/sdk/src/abi/**',
    '**/__snapshots__/**',
    'bun.lock',
    // Vendored from dmmulroy/anti-slop in upstream style (tools/oxlint/anti-slop/PROVENANCE.md).
    'tools/oxlint/anti-slop/**',
    '**/.alchemy/**',
    '**/dist/**',
    '**/.output/**',
    '**/.tanstack/**',
    '**/.source/**',
    '**/routeTree.gen.ts',
  ],
})
