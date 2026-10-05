import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { test } from 'node:test'
import { reportCliFailure } from './cli-errors.mjs'

test('provider credentials and URL details never reach the CLI error line', () => {
  const lines = []
  const credentialed = new TypeError('fetch failed for http://user:secret@example.invalid/rpc?token=private')
  reportCliFailure('Crew migration failed', credentialed, line => lines.push(line))
  assert.deepEqual(lines, ['Crew migration failed [TypeError]'])
  assert.equal(lines.join('\n').includes('user:secret@example.invalid'), false)
  const poisoned = new Error('provider body')
  poisoned.name = 'rpc-secret'
  reportCliFailure('Crew migration failed', poisoned, line => lines.push(line))
  assert.equal(lines.at(-1), 'Crew migration failed [Error]')
})

for (const entry of [
  { label: 'migration with lock parent', args: [process.env.CREW_MIGRATION_TEST_ENTRY ?? 'scripts/crew-migrate-g1c.ts', 'workers'], prefix: 'Crew migration failed', env: {} },
  { label: 'migration inside lock', args: [process.env.CREW_MIGRATION_TEST_ENTRY ?? 'scripts/crew-migrate-g1c.ts', 'workers'], prefix: 'Crew migration failed', env: { CREW_MIGRATION_LOCKED: '1' } },
  { label: 'worker', args: ['packages/sdk/scripts/demo-workers.ts', 'once'], prefix: 'Worker command failed', env: { DEMO_WORKER_SLUG: 'canvas', CLIPROXY_API_KEY: 'test-only' } },
  { label: 'demand', args: ['packages/sdk/scripts/demand-bot.ts', 'status'], prefix: 'Demand command failed', env: { DEMAND_BOT_PRIVATE_KEY: `0x${'1'.padStart(64, '0')}` } },
]) test(`${entry.label} CLI hides a credentialed RPC URL on a provider failure`, async () => {
  let requests = 0
  const server = createServer((_request, response) => {
    requests++
    response.writeHead(401)
    response.end('provider-private-body')
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const directory = mkdtempSync(join(tmpdir(), 'crew-migration-'))
  try {
    const address = server.address()
    assert.equal(typeof address, 'object')
    const url = `http://127.0.0.1:${address.port}/rpc-secret?credential=private`
    if (!entry.env.DEMAND_BOT_PRIVATE_KEY) writeFileSync(join(directory, 'journal.json'), JSON.stringify({ binding: '', values: {}, sends: {} }))
    const result = await new Promise((resolve, reject) => {
      const child = spawn('pnpm', ['exec', 'bun', ...entry.args, ...(entry.label.startsWith('migration') ? [directory] : [])], {
        cwd: process.cwd(), env: { ...process.env, ...entry.env, MONAD_TESTNET_RPC_URL: url,
          DEMO_WORKER_STATE_DIR: directory, DEMAND_BOT_STATE_DIR: directory },
      })
      let stdout = ''
      let stderr = ''
      child.stdout.on('data', bytes => { stdout += bytes })
      child.stderr.on('data', bytes => { stderr += bytes })
      child.on('error', reject)
      child.on('close', status => resolve({ status, stdout, stderr }))
    })
    assert.ok(requests > 0, 'the real HTTP endpoint must receive the failed RPC')
    assert.notEqual(result.status, 0)
    assert.ok(result.stderr.includes(`${entry.prefix} [`))
    assert.equal(result.stderr.includes(url), false)
    assert.equal(result.stderr.includes('rpc-secret'), false)
    assert.equal(result.stderr.includes('provider-private-body'), false)
    assert.equal(result.stderr.includes('127.0.0.1'), false)
    assert.equal(result.stdout.includes('rpc-secret'), false)
    assert.equal(result.stdout.includes('provider-private-body'), false)
  } finally {
    await new Promise(resolve => server.close(resolve))
    rmSync(directory, { recursive: true })
  }
})
