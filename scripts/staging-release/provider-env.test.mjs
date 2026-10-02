import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { parseEnv } from 'node:util'
import { assertSafeProviderEnv } from './provider-env.mjs'
import { reportReleaseFailure } from './errors.mjs'

test('preflight refuses any set DISTILLED_DEBUG family member in either environment source', () => {
  for (const name of ['DISTILLED_DEBUG_HTTP', 'DISTILLED_DEBUG', 'DISTILLED_DEBUG_FUTURE']) {
    for (const value of ['1', '0', '']) {
      for (const fromFile of [false, true]) {
        const inherited = fromFile ? {} : { [name]: value }
        const local = fromFile ? parseEnv(`${name}=${value}\n`) : {}
        assert.throws(() => assertSafeProviderEnv(inherited, local), { message: 'guard-debug-env-set' })
      }
    }
  }
  assert.doesNotThrow(() => assertSafeProviderEnv({}, { NODE_ENV: 'production' }))
  assert.throws(() => assertSafeProviderEnv({ DISTILLED_DEBUG_HTTP: '1' }, { DISTILLED_DEBUG_HTTP: '' }), { message: 'guard-debug-env-set' })
})

test('debug refusal happens before a provider error can print its response body', async () => {
  const originalError = console.error
  const lines = []
  console.error = line => lines.push(line)
  let providerCalls = 0
  const provider = async () => {
    providerCalls++
    console.error('[distilled] <- 500 private response body')
    throw new Error('private response body')
  }
  try {
    for (const source of [{ DISTILLED_DEBUG_HTTP: '1' }, parseEnv('DISTILLED_DEBUG_HTTP=1\n')]) {
      try {
        assertSafeProviderEnv(source)
        await provider()
      } catch (error) { reportReleaseFailure(error) }
    }
    assert.equal(providerCalls, 0)
    assert.deepEqual(lines, ['Staging release stopped: guard-debug-env-set', 'Staging release stopped: guard-debug-env-set'])
  } finally { console.error = originalError }
})

test('release checks inherited and local env before census, Alchemy registration and provider calls', () => {
  const source = readFileSync(new URL('./release.mjs', import.meta.url), 'utf8')
  assert.ok(source.indexOf('assertSafeProviderEnv(process.env)') < source.indexOf("git('branch', '--show-current')"))
  assert.ok(source.indexOf('assertSafeProviderEnv(localEnv)') < source.indexOf('Object.assign(process.env, localEnv)'))
  assert.ok(source.indexOf('preflight()\n') < source.indexOf('await census()'))
  assert.ok(source.indexOf('preflight()\n') < source.indexOf("await import(resolve(repo, 'node_modules/alchemy/bin/register-oxc.js'))"))
})
