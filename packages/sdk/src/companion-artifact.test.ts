import { createHash } from 'node:crypto'
import { builtinModules } from 'node:module'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'node:http'
import { generateKeyPairSync } from 'node:crypto'
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
    // Exercise the emitted launcher with a real child process that deliberately prints credential-looking output.
    // The HTTP endpoint is a local health fixture, not deployed acceptance.
    const directory = await mkdtemp(join(tmpdir(), 'hireling-process-boundary-'))
    const healthStates: string[] = []
    const server = createServer(async (request, response) => {
      let body = ''
      for await (const chunk of request) body += String(chunk)
      if (request.method === 'POST') healthStates.push((JSON.parse(body) as { status: string }).status)
      response.setHeader('content-type', 'application/json')
      response.end(JSON.stringify({ ok: true, result: request.method === 'GET' ? { challenge: 'local-fixture', expiresAt: Math.floor(Date.now() / 1000) + 60 } : {} }))
    })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    try {
      const address = server.address()
      if (!address || typeof address === 'string') throw new Error('fixture server unavailable')
      const apiOrigin = `http://127.0.0.1:${address.port}`
      const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
      const statePath = join(directory, 'state.json'), modulePath = join(directory, 'companion.mjs'), workerPath = join(directory, 'worker')
      await writeFile(modulePath, artifact.code)
      await writeFile(statePath, JSON.stringify({ apiOrigin, managedId: 'fixture', generation: 0, runtimeToken: 'fixture-token', privateKeyPem: privateKey.export({ format: 'pem', type: 'pkcs8' }).toString(), journal: {} }), { mode: 0o600 })
      await writeFile(workerPath, '#!/usr/bin/env node\nconst fs = require("node:fs"); fs.writeFileSync(process.env.HOME + "/child-env.json", JSON.stringify(process.env)); console.log("worker-output-secret"); console.error("worker-stderr-secret"); setTimeout(() => console.log(JSON.stringify({type:"system",subtype:"init",mcp_servers:[{name:"hireling-wallet",status:"connected"}]})), 100); setTimeout(() => process.exit(0), 500);\n', { mode: 0o700 })
      const childResult = await promisify(execFile)(process.execPath, [modulePath, 'run', '--prompt', 'fixture'], { timeout: 10_000, env: { PATH: process.env.PATH, HOME: directory, HIRELING_STATE: statePath, HIRELING_AGENT_COMMAND: workerPath, ANTHROPIC_BASE_URL: 'http://cliproxy', ANTHROPIC_AUTH_TOKEN: 'parent-provider-secret', ANTHROPIC_CUSTOM_HEADERS: 'x-parent-secret', ANTHROPIC_API_KEY: 'parent-provider-api-secret', CLIPROXY_API_KEY: 'parent-cliproxy-secret', WORKER_PRIVATE_KEY: 'parent-wallet-secret', PRIVY_APP_SECRET: 'parent-privy-secret' } })
      const inherited = JSON.parse(await readFile(join(directory, 'child-env.json'), 'utf8')) as Record<string, string>
      expect(inherited).toMatchObject({ ANTHROPIC_BASE_URL: 'http://cliproxy', ANTHROPIC_AUTH_TOKEN: 'parent-provider-secret', ANTHROPIC_CUSTOM_HEADERS: 'x-parent-secret', ANTHROPIC_API_KEY: 'parent-provider-api-secret', CLIPROXY_API_KEY: 'parent-cliproxy-secret' })
      for (const key of ['WORKER_PRIVATE_KEY', 'PRIVY_APP_SECRET', 'HIRELING_STATE']) expect(inherited).not.toHaveProperty(key)
      expect(inherited.HIRELING_MANAGED_AGENT_ID).toBe('fixture')
      expect(childResult.stdout + childResult.stderr).not.toMatch(/worker-output-secret|worker-stderr-secret|parent-provider-secret|parent-cliproxy-secret|parent-wallet-secret|parent-privy-secret/)
      expect(healthStates).toEqual(['launched', 'ready', 'stopped'])
    } finally {
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
      await rm(directory, { recursive: true, force: true })
    }
  }, 30_000)
})
