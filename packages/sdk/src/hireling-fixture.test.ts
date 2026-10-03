import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { afterEach, expect, it, vi } from 'vitest'

const spawn = vi.hoisted(() => vi.fn())
vi.mock('node:child_process', async importOriginal => ({ ...await importOriginal<typeof import('node:child_process')>(), spawn }))
import { startHirelingFork } from '../test/hireling-fixture.ts'

afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); vi.clearAllMocks() })

it('reports anvil startup stderr and exit status without exposing the fork URL', async () => {
  vi.stubEnv('MONAD_TESTNET_RPC_URL', 'https://user:secret@rpc.invalid/path?token=secret')
  vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('not listening') }))
  const node = Object.assign(new EventEmitter(), { stderr: new PassThrough(), exitCode: null as number | null, signalCode: null, kill: vi.fn() })
  spawn.mockImplementationOnce(() => {
    queueMicrotask(() => {
      node.stderr.write(`Failed to connect to ${process.env.MONAD_TESTNET_RPC_URL}: RPC rate limit exceeded\n`)
      node.exitCode = 1
    })
    return node
  })
  await expect(startHirelingFork()).rejects.toThrow('Local anvil exited before readiness (exit 1, signal none): Failed to connect to [redacted RPC URL] RPC rate limit exceeded')
  expect(node.kill).toHaveBeenCalledOnce()
  expect(spawn.mock.calls[0]?.[1]).toContain('--port')
})

it('reports anvil spawn errors and cleans up the child', async () => {
  vi.stubEnv('MONAD_TESTNET_RPC_URL', 'https://rpc.invalid')
  vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('not listening') }))
  const node = Object.assign(new EventEmitter(), { stderr: new PassThrough(), exitCode: null, signalCode: null, kill: vi.fn() })
  spawn.mockImplementationOnce(() => {
    queueMicrotask(() => { node.emit('error', new Error('spawn anvil ENOENT')) })
    return node
  })
  await expect(startHirelingFork()).rejects.toThrow('spawn anvil ENOENT')
  expect(node.kill).toHaveBeenCalledOnce()
})
