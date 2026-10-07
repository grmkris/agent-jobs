import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it } from 'vitest'
import * as sdk from '@sidequest/sdk'
import { encodeAbiParameters, encodeEventTopics } from 'viem'
import { delegationsOf, delegatorsOf, indexedDelegations } from './delegations.ts'
import { contractsFromDeployment, decode } from './events.ts'
import { fromNodeSqlite, migrate, stmt } from './store.ts'

const account = '0x1111111111111111111111111111111111111111'
const other = '0x2222222222222222222222222222222222222222'
const wallet = '0x3333333333333333333333333333333333333333'
const second = '0x4444444444444444444444444444444444444444'
const d = sdk.deployment('monad-testnet')
const vault = d.sidequest!.vault

describe('delegation discovery in the existing protocol ledger', () => {
  it('filters by vault, chain, account, owner and exclusive checkpoint, preserving same-block generation order', async () => {
    const db = new DatabaseSync(':memory:')
    const sql = fromNodeSqlite(db)
    try {
      await migrate(sql)
      const entries = [
        [100, 2, 'Delegated', { account, delegator: wallet }],
        [100, 8, 'PoolReset', { account, generation: '1' }],
        [100, 9, 'Delegated', { account, delegator: second }],
        [101, 0, 'Delegated', { account: other, delegator: wallet }],
        [102, 0, 'Delegated', { account, delegator: wallet }],
      ] as const
      await sql.batch(
        entries.map(([block, index, name, args]) =>
          stmt(
            'INSERT INTO protocol_events VALUES (?,?,?,?,?,?,?)',
            d.chainId,
            vault,
            block,
            index,
            '0xreceipt',
            name,
            JSON.stringify(args),
          ),
        ),
      )
      await sql.batch([
        stmt(
          'INSERT INTO protocol_events VALUES (?,?,?,?,?,?,?)',
          143,
          vault,
          99,
          0,
          '0xother-chain',
          'Delegated',
          JSON.stringify({ account: other, delegator: second }),
        ),
        stmt(
          'INSERT INTO protocol_events VALUES (?,?,?,?,?,?,?)',
          d.chainId,
          second,
          99,
          0,
          '0xother-vault',
          'Delegated',
          JSON.stringify({ account: other, delegator: second }),
        ),
      ])
      expect(await delegatorsOf(sql, d.chainId, vault, account, 102)).toEqual([
        { account, delegator: wallet, generation: 0n },
        { account, delegator: second, generation: 1n },
      ])
      expect(await delegationsOf(sql, d.chainId, vault, wallet, 102)).toEqual([
        { account, delegator: wallet, generation: 0n },
        { account: other, delegator: wallet, generation: 0n },
      ])
      expect(await indexedDelegations(sql, d.chainId, vault, { wallet, account })).toEqual([
        { account, delegator: wallet, generation: 1n },
      ])
      expect(await delegatorsOf(sql, d.chainId, vault, account, 100)).toEqual([])
    } finally {
      db.close()
    }
  })

  it('decodes the new vault ledger through the generated ABI', () => {
    const contracts = contractsFromDeployment(d)
    const decoded = decode(contracts, {
      address: vault,
      block_number: 100,
      log_index: 1,
      transaction_hash: `0x${'01'.repeat(32)}`,
      topic0: encodeEventTopics({
        abi: sdk.stakeVaultAbi,
        eventName: 'Delegated',
        args: { account, delegator: wallet, payer: second },
      })[0]!,
      topic1: encodeAbiParameters([{ type: 'address' }], [account]),
      topic2: encodeAbiParameters([{ type: 'address' }], [wallet]),
      topic3: encodeAbiParameters([{ type: 'address' }], [second]),
      data: encodeAbiParameters([{ type: 'uint256' }, { type: 'uint256' }], [7n, 9n]),
    })
    expect(decoded).toMatchObject({
      name: 'Delegated',
      jobId: null,
      args: { account, delegator: wallet, payer: second, assets: '7', shares: '9' },
    })
  })
})
