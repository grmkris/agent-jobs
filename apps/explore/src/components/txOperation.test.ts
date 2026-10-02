import { describe, expect, it } from 'vitest'
import { reconcileSend, retryAction, walletRefused } from './txOperation.ts'

const hash = `0x${'1'.repeat(64)}` as const

describe('wallet step retry reconciliation', () => {
  it('never resends a transaction after a receipt timeout', () => {
    expect(retryAction({ at: 'failed', error: 'RPC unavailable', hash })).toBe('receipt')
  })
  it('only records a confirmed transaction when the board report failed', () => {
    expect(retryAction({ at: 'confirmed', hash, reportError: 'Board unavailable' })).toBe('report')
  })
  it('permits a new send only without a hash or after a proved revert', () => {
    expect(retryAction({ at: 'idle' })).toBe('send')
    expect(retryAction({ at: 'failed', error: 'Wallet declined' })).toBe('send')
    expect(retryAction({ at: 'failed', error: 'Reverted', hash, reverted: true })).toBe('send')
  })
  it('does not act on pending or completed steps', () => {
    expect(retryAction({ at: 'signing' })).toBe('wait')
    expect(retryAction({ at: 'sent', hash })).toBe('wait')
    expect(retryAction({ at: 'confirmed', hash })).toBe('wait')
    expect(retryAction({ at: 'recorded', hash })).toBe('wait')
    expect(retryAction({ at: 'uncertain', error: 'Transport failed after broadcast' })).toBe('wait')
  })
  it('only clears uncertainty after a definitive wallet refusal', () => {
    expect(walletRefused({ cause: { code: 4001 } })).toBe(true)
    expect(walletRefused({ code: 'ACTION_REJECTED' })).toBe(true)
    expect(walletRefused(new Error('Transport failed after broadcast'))).toBe(false)
    expect(walletRefused(new Error('Request cancelled after submission'))).toBe(false)
  })
})

describe('ambiguous send reconciliation', () => {
  const owner = '0x1111111111111111111111111111111111111111'
  const call = { to: '0x2222222222222222222222222222222222222222', data: '0xabcdef' as const }
  const tx = (n: number, input: `0x${string}`, from = owner, to = call.to) => ({ hash: `0x${n.toString(16).padStart(64, '0')}` as `0x${string}`, from, to, input, nonce: n })
  /** A chain whose block 100 + k holds the listed transactions; reads fail when `down`. */
  const chain = (opts: { mined: number; pending?: number; blocks?: Record<number, ReturnType<typeof tx>[]>; head?: number; down?: boolean }) => {
    const reads = { blocks: 0 }
    return {
      reads,
      chain: {
        nonce: async (tag: 'latest' | 'pending') => {
          if (opts.down === true) throw new Error('RPC unavailable')
          return tag === 'latest' ? opts.mined : (opts.pending ?? opts.mined)
        },
        blockNumber: async () => BigInt(opts.head ?? 110),
        block: async (n: bigint) => {
          reads.blocks++
          return { transactions: opts.blocks?.[Number(n)] ?? [] }
        },
      },
    }
  }
  const snapshot = { nonce: 5, block: '100' }

  it('says nothing went out when the nonce has not moved and nothing is pending', async () => {
    const { chain: c, reads } = chain({ mined: 5 })
    expect(await reconcileSend(c, snapshot, owner, call)).toEqual({ at: 'not-sent' })
    expect(reads.blocks).toBe(0)
  })
  it('waits while the account has a transaction in the mempool', async () => {
    expect(await reconcileSend(chain({ mined: 5, pending: 6 }).chain, snapshot, owner, call)).toEqual({ at: 'pending' })
  })
  it('finds the mined transaction that carries this exact call', async () => {
    const { chain: c, reads } = chain({ mined: 6, blocks: { 102: [tx(9, '0xabcdef', '0x3333333333333333333333333333333333333333'), tx(5, '0xABCDEF')] } })
    expect(await reconcileSend(c, snapshot, owner, call)).toEqual({ at: 'found', hash: tx(5, '0x').hash })
    expect(reads.blocks).toBe(3)
  })
  it('allows a resend when the nonce moved for another call of this account', async () => {
    const { chain: c, reads } = chain({ mined: 6, blocks: { 101: [tx(5, '0x1234')] } })
    expect(await reconcileSend(c, snapshot, owner, call)).toEqual({ at: 'not-sent' })
    expect(reads.blocks).toBe(2)
  })
  it('does not guess when the chain cannot answer or the blocks run past the limit', async () => {
    expect(await reconcileSend(chain({ mined: 5, down: true }).chain, snapshot, owner, call)).toEqual({ at: 'unknown' })
    expect(await reconcileSend(chain({ mined: 6, head: 400 }).chain, snapshot, owner, call, 50)).toEqual({ at: 'unknown' })
  })
})
