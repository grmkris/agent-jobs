import { createHash } from 'node:crypto'
import { builtinModules } from 'node:module'
import { describe, it, expect } from 'vitest'
import { build } from 'vite-plus'

/** The installable module must carry its dependencies and retain client environment overrides. */
describe('downloaded companion artifact', () => {
  it('bundles all package imports and keeps runtime agent configuration', async () => {
    const result = await build({ configFile: false, logLevel: 'silent', define: { 'process.env': 'process.env' }, build: { target: 'es2022', write: false, minify: false, rollupOptions: { input: new URL('../scripts/companion.ts', import.meta.url).pathname, external: [...builtinModules, ...builtinModules.map(n => `node:${n}`)], output: { format: 'es', inlineDynamicImports: true } } } })
    const outputs = Array.isArray(result) ? result.flatMap(r => r.output) : 'output' in result ? result.output : []
    const artifact = outputs.find(o => o.type === 'chunk' && o.isEntry)
    if (artifact?.type !== 'chunk') throw new Error('no companion artifact')
    expect(createHash('sha256').update(artifact.code).digest('hex')).toHaveLength(64)
    expect(/^[ \t]*import[^\n]*from ['"](?:viem|@[^'"/]+|\.\.?\/)/m.test(artifact.code)).toBe(false)
    expect(artifact.code).toContain('process.env.HIRELING_STATE')
    expect(artifact.code).toContain('process.env.HIRELING_AGENT_COMMAND')
  }, 30_000)
})
