/** Fault and time fixtures on a local fork of the actual deployed state. */
import { spawn } from 'node:child_process'
import { createPublicClient, http } from 'viem'
import { monadTestnet } from 'viem/chains'
import { localTestPort } from '../../../test/fork-port.ts'
import { required } from './guards.ts'

export async function deployedFork(blockNumber: bigint) {
  const port = await localTestPort()
  const url = `http://127.0.0.1:${port}`
  const child = spawn(
    'anvil',
    [
      '--fork-url',
      required('MONAD_TESTNET_RPC_URL'),
      '--fork-block-number',
      blockNumber.toString(),
      '--network',
      'monad',
      '--chain-id',
      '10143',
      '--accounts',
      '0',
      '--host',
      '127.0.0.1',
      '--port',
      String(port),
      '--compute-units-per-second',
      '100',
      '--no-fork-node-info',
      '--silent',
    ],
    { stdio: 'ignore' },
  )
  let failed = false
  child.once('error', () => {
    failed = true
  })
  const rpc = async <T = unknown>(method: string, params: unknown[] = []): Promise<T> => {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
      signal: AbortSignal.timeout(30_000),
    })
    const value = (await response.json()) as { result: T; error?: unknown }
    if (value.error !== undefined) throw new Error('P8_LOCAL_FORK_RPC_REFUSED')
    return value.result
  }
  const stop = () => {
    if (child.exitCode === null) child.kill('SIGTERM')
  }
  process.once('SIGTERM', stop)
  process.once('SIGINT', stop)
  const close = async () => {
    process.removeListener('SIGTERM', stop)
    process.removeListener('SIGINT', stop)
    if (child.exitCode !== null || child.signalCode !== null) return
    const ended = new Promise<void>((resolve) => child.once('exit', () => resolve()))
    stop()
    const force = setTimeout(() => child.kill('SIGKILL'), 2000)
    await ended
    clearTimeout(force)
  }
  try {
    const until = Date.now() + 90_000
    let ready = false
    while (!ready && Date.now() < until) {
      if (failed || child.exitCode !== null) throw new Error('P8_ANVIL_START_FAILED')
      ready = await rpc('eth_chainId')
        .then((result) => result === '0x279f')
        .catch(() => false)
      if (!ready) await new Promise((resolve) => setTimeout(resolve, 200))
    }
    if (!ready) throw new Error('P8_LOCAL_FORK_START_TIMEOUT')
    return {
      client: createPublicClient({
        chain: monadTestnet,
        transport: http(url),
        pollingInterval: 100,
      }),
      rpc,
      close,
    }
  } catch (error) {
    await close()
    throw error
  }
}
