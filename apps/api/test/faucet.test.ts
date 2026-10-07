import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it, vi } from 'vitest'
import { fromNodeSqlite } from '@sidequest/indexer'
import type { Address, Hex } from 'viem'
import { migrateRegistry } from '../src/registry.ts'
import { type FaucetChain, claimFaucet } from '../src/faucet.ts'

const MON = 10n ** 18n
const user = '0x00000000000000000000000000000000000000aa' as Address
const relay = '0x00000000000000000000000000000000000000bb' as Address
const faucet = '0x311746E7B0dbadC0E905eDa3Fc5c4d281187Fada' as Address
const hash = `0x${'1'.repeat(64)}` as Hex

function stubChain(over: Partial<FaucetChain> & { userMon?: bigint; relayMon?: bigint } = {}) {
  const sends: unknown[] = []
  const chain: FaucetChain = {
    chainId: 10143,
    call: (to) => ({ to: faucet, data: `0xdrip${to.slice(2)}` as Hex }),
    lastDrip: async () => 0n,
    nextDripAt: async () => 0,
    balance: async (a) => (a === relay ? (over.relayMon ?? 5n * MON) : (over.userMon ?? 0n)),
    relay,
    relaySend: async (tx) => {
      sends.push(tx)
      return hash
    },
    receipt: async () => 'success',
    dripMon: async () => ({ status: 'sent', txHash: hash }),
    ...over,
  }
  return { chain, sends }
}

async function deps(chain: FaucetChain | undefined, network: 'monad-testnet' | 'monad-mainnet' = 'monad-testnet') {
  const sql = fromNodeSqlite(new DatabaseSync(':memory:'))
  await migrateRegistry(sql)
  return { sql, network, now: () => 1_791_300_000, chain }
}

describe('testnet faucet claims', () => {
  it('pays the gas from the relay for a wallet without MON, then drips its first MON', async () => {
    const { chain, sends } = stubChain()
    const d = await deps(chain)
    expect(await claimFaucet(d, { address: user })).toEqual({
      status: 'sent',
      txHash: hash,
      mon: { status: 'sent', txHash: hash },
    })
    expect(sends).toEqual([{ to: faucet, data: `0xdrip${user.slice(2)}` }])
  })

  it('returns the transaction for a wallet with MON instead of spending the relay', async () => {
    const { chain, sends } = stubChain({ userMon: MON / 10n })
    const out = await claimFaucet(await deps(chain), { address: user })
    expect(out).toEqual({ status: 'self', transaction: { to: faucet, data: `0xdrip${user.slice(2)}`, chainId: 10143 } })
    expect(sends).toHaveLength(0)
  })

  it('reports the cooldown, keeps the relay above its reserve, and refuses mainnet and a missing faucet', async () => {
    expect(
      await claimFaucet(await deps(stubChain({ nextDripAt: async () => 1_791_380_000 }).chain), { address: user }),
    ).toEqual({ status: 'cooldown', nextAt: 1_791_380_000 })
    const low = stubChain({ relayMon: 2n * MON })
    expect(await claimFaucet(await deps(low.chain), { address: user })).toMatchObject({
      status: 'unavailable',
      reason: expect.stringContaining('relay is low'),
    })
    expect(low.sends).toHaveLength(0)
    expect(await claimFaucet(await deps(stubChain().chain, 'monad-mainnet'), { address: user })).toMatchObject({
      status: 'unavailable',
    })
    expect(await claimFaucet(await deps(undefined), { address: user })).toMatchObject({ status: 'unavailable' })
  })

  it('never sends twice for one claim: a confirming send stays pending, a reverted one may be retried', async () => {
    let receipt: 'success' | 'reverted' | undefined = undefined
    const { chain, sends } = stubChain({ receipt: async (_h, wait) => (wait ? 'success' : receipt) })
    const d = await deps(chain)
    await claimFaucet(d, { address: user })
    expect(await claimFaucet(d, { address: user })).toMatchObject({ status: 'pending' })
    receipt = 'success'
    expect(await claimFaucet(d, { address: user })).toMatchObject({ status: 'pending' })
    expect(sends).toHaveLength(1)
    receipt = 'reverted'
    expect(await claimFaucet(d, { address: user })).toMatchObject({ status: 'sent' })
    expect(sends).toHaveLength(2)
  })

  it('marks a failed send so the next request can retry, and logs no RPC text to the caller', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    let fail = true
    const { chain, sends } = stubChain({
      relaySend: async (tx) => {
        if (fail) throw new Error('rpc said something private')
        sends.push(tx)
        return hash
      },
    })
    const d = await deps(chain)
    const out = await claimFaucet(d, { address: user })
    expect(out).toEqual({ status: 'unavailable', reason: 'the faucet send failed; try again later' })
    fail = false
    expect(await claimFaucet(d, { address: user })).toMatchObject({ status: 'sent' })
    error.mockRestore()
  })
})
