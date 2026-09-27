/**
 * A live log query against the testnet deployment through HyperSync and the chain's finalized head (plan S4).
 * Skipped without HYPERSYNC_API_TOKEN and MONAD_TESTNET_RPC_URL.
 */
import * as sdk from '@agent-jobs/sdk'
import { describe, expect, it } from 'vitest'
import { contractsOf, decode, hyperSync, rpcHead } from './index.ts'

const token = process.env.HYPERSYNC_API_TOKEN ?? ''
const rpc = process.env.MONAD_TESTNET_RPC_URL ?? ''
const live = token === '' || rpc === '' ? describe.skip : describe

live('HyperSync on monad-testnet (read-only)', () => {
  it('finds and decodes the deployment’s first publications below the finalized head', async () => {
    const contracts = contractsOf('monad-testnet')
    const finalized = await rpcHead(rpc).finalizedBlock()
    const from = Number(sdk.deployment('monad-testnet').deployBlock)
    const page = await hyperSync('https://monad-testnet.hypersync.xyz', token).logs({
      fromBlock: from,
      toBlock: finalized + 1,
      addresses: [...contracts.roles.keys()],
    })
    expect(page.nextBlock).toBeGreaterThan(from)
    const events = page.logs.map((l) => decode(contracts, l)).filter((e) => e !== undefined)
    expect(events.some((e) => e.name === 'Published')).toBe(true)
    expect(events.every((e) => e.block >= from && e.block <= finalized)).toBe(true)
  }, 60_000)
})
