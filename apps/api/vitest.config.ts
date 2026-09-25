import { defineConfig } from 'vitest/config'

/**
 * alchemy resolves Cloudflare credentials even for local providers (`dev: true` still reads the
 * account id into the runtime env), and with none present it would fall back to profile
 * resolution, which prompts. Placeholders keep the suite hermetic; nothing in it reaches the
 * cloud, and real values in the environment win when present.
 */
const PLACEHOLDER_ACCOUNT_ID = '0'.repeat(32)

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    env: {
      CLOUDFLARE_ACCOUNT_ID: process.env.CLOUDFLARE_ACCOUNT_ID ?? PLACEHOLDER_ACCOUNT_ID,
      CLOUDFLARE_API_TOKEN: process.env.CLOUDFLARE_API_TOKEN ?? 'local-placeholder-token',
      ALCHEMY_PLAIN: '1',
    },
    // The stack boots workerd once per file; give it room.
    testTimeout: 60_000,
    hookTimeout: 120_000,
  },
})
