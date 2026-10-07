import { readdirSync, readFileSync } from 'node:fs'
import { defineConfig } from 'vitest/config'

/**
 * alchemy resolves Cloudflare credentials even for local providers (`dev: true` still reads the
 * account id into the runtime env), and with none present it would fall back to profile
 * resolution, which prompts. Placeholders keep the suite hermetic; nothing in it reaches the
 * cloud, and real values in the environment win when present.
 */
const PLACEHOLDER_ACCOUNT_ID = '0'.repeat(32)

/**
 * The files that boot workerd through alchemy's test harness. Every sidecar opens the same metadata databases under
 * .alchemy/local (D1 and cache objects), so two booting at once can fail with SQLITE_BUSY: they run one at a time.
 */
const testDir = new URL('./test/', import.meta.url)
const WORKERD = readdirSync(testDir, { recursive: true, encoding: 'utf8' })
  .filter(
    (file) =>
      file.endsWith('.test.ts') && readFileSync(new URL(file, testDir), 'utf8').includes("'alchemy/Test/Vitest'"),
  )
  .map((file) => `test/${file}`)

export default defineConfig({
  test: {
    // Each integration file starts its own bundler and workerd sidecar. Bound parallel boots on the shared box.
    maxWorkers: 2,
    env: {
      CLOUDFLARE_ACCOUNT_ID: process.env.CLOUDFLARE_ACCOUNT_ID ?? PLACEHOLDER_ACCOUNT_ID,
      CLOUDFLARE_API_TOKEN: process.env.CLOUDFLARE_API_TOKEN ?? 'local-placeholder-token',
      ALCHEMY_PLAIN: '1',
      // Explore's local Vite child needs a remote Cloudflare session; this suite probes the API's bindings only.
      SIDEQUEST_WITHOUT_EXPLORE: '1',
    },
    // The stack boots workerd once per file; give it room.
    testTimeout: 60_000,
    hookTimeout: 120_000,
    projects: [
      { extends: true, test: { name: 'unit', include: ['test/**/*.test.ts'], exclude: WORKERD } },
      { extends: true, test: { name: 'workerd', include: WORKERD, fileParallelism: false } },
    ],
  },
})
