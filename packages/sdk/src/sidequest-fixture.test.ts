import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { afterEach, expect, it, vi } from 'vitest'

const spawn = vi.hoisted(() => vi.fn())
vi.mock('node:child_process', async importOriginal => ({ ...await importOriginal<typeof import('node:child_process')>(), spawn }))
import { startSidequestFork } from '../test/sidequest-fixture.ts'

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
  await expect(startSidequestFork()).rejects.toThrow('Local anvil exited before readiness (exit 1, signal none): Failed to connect to [redacted RPC URL] RPC rate limit exceeded')
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
  await expect(startSidequestFork()).rejects.toThrow('spawn anvil ENOENT')
  expect(node.kill).toHaveBeenCalledOnce()
})

it('identifies the funding phase and RPC method when a configurable request timeout expires', async () => {
  vi.stubEnv('MONAD_TESTNET_RPC_URL', 'https://rpc.invalid')
  vi.stubEnv('FORK_RPC_TIMEOUT_MS', '1234')
  const fetch = vi.fn(async (_url: string, init: RequestInit) => {
    const method = JSON.parse(init.body as string).method
    if (method === 'eth_chainId') return { json: async () => ({ result: '0x279f' }) }
    throw new DOMException('aborted', 'TimeoutError')
  })
  vi.stubGlobal('fetch', fetch)
  const node = Object.assign(new EventEmitter(), { stderr: new PassThrough(), exitCode: null, signalCode: null, kill: vi.fn() })
  spawn.mockReturnValueOnce(node)
  await expect(startSidequestFork()).rejects.toThrow('RPC timed out during account funding (anvil_setBalance; 1234ms)')
  expect(node.kill).toHaveBeenCalledOnce()
})

it('reports a readiness deadline separately from a funding RPC timeout', async () => {
  vi.stubEnv('MONAD_TESTNET_RPC_URL', 'https://rpc.invalid')
  vi.stubEnv('FORK_STARTUP_TIMEOUT_MS', '1')
  vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('not listening') }))
  const node = Object.assign(new EventEmitter(), { stderr: new PassThrough(), exitCode: null, signalCode: null, kill: vi.fn() })
  spawn.mockReturnValueOnce(node)
  await expect(startSidequestFork()).rejects.toThrow('Local anvil readiness timed out (1ms)')
  expect(node.kill).toHaveBeenCalledOnce()
})

it.each(['0', '-1', 'NaN', '600001'])('refuses malformed timeout %s before spawning a fork', async timeout => {
  vi.stubEnv('FORK_RPC_TIMEOUT_MS', timeout)
  await expect(startSidequestFork()).rejects.toThrow('FORK_RPC_TIMEOUT_MS must be 1..600000 milliseconds')
  expect(spawn).not.toHaveBeenCalled()
})
