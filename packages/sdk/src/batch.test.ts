import { type Address, type Hex, decodeFunctionData } from 'viem'
import { describe, expect, it } from 'vitest'
import type { Wallet } from './actions.ts'
import { batchCalldata, delegationOf, sendBatch, setAuthorizationSigner, simple7702AccountAbi } from './batch.ts'
import type { TxRequest } from './board-client.ts'

const ME = '0x1111111111111111111111111111111111111111' as Address
const DELEGATE = '0xe6Cae83BdE06E4c305530e199D7217f42808555B' as Address
const tx = (to: string, data: Hex, description = 'x'): TxRequest => ({ description, chainId: 10143, to: to as Address, data, value: '0' })
const TXS = [tx('0x2222222222222222222222222222222222222222', '0xaaaa', 'approve'), tx('0x3333333333333333333333333333333333333333', '0xbbbb', 'publish')]

function fakes(code: Hex | undefined, status = 'success') {
  const sent: Array<Record<string, unknown>> = []
  let signedAuth = 0
  const wallet = {
    account: { address: ME, type: 'local' },
    chain: { id: 10143 },
    sendTransaction: async (a: Record<string, unknown>) => {
      sent.push(a)
      return `0x${'ab'.repeat(32)}` as Hex
    },
    signAuthorization: async (a: { contractAddress: Address; executor?: string }) => {
      signedAuth++
      expect(a.executor).toBe('self')
      return { address: a.contractAddress, chainId: 10143, nonce: 1, r: '0x01', s: '0x02', yParity: 0 }
    },
  } as unknown as Wallet
  const reads = {
    getCode: async () => code,
    getTransactionCount: async () => 7,
    waitForTransactionReceipt: async () => ({ status }),
  }
  return { wallet, reads, sent, signed: () => signedAuth }
}

describe('EIP-7702 batches', () => {
  it('reads a delegation designator and nothing else', async () => {
    expect(await delegationOf({ getCode: async () => `0xef0100${DELEGATE.slice(2)}` as Hex }, ME)).toBe(`0x${DELEGATE.slice(2)}`)
    expect(await delegationOf({ getCode: async () => undefined }, ME)).toBeNull()
    expect(await delegationOf({ getCode: async () => '0x6080604052' }, ME)).toBeNull()
  })

  it('encodes the board transactions in order as executeBatch calls', () => {
    const { functionName, args } = decodeFunctionData({ abi: simple7702AccountAbi, data: batchCalldata(TXS) })
    expect(functionName).toBe('executeBatch')
    expect(args[0].map((c) => [c.target.toLowerCase(), c.value, c.data])).toEqual([
      ['0x2222222222222222222222222222222222222222', 0n, '0xaaaa'],
      ['0x3333333333333333333333333333333333333333', 0n, '0xbbbb'],
    ])
  })

  it('first batch: signs an authorization and sends one type-4 call to itself', async () => {
    const f = fakes('0x')
    await sendBatch(f.wallet, f.reads, TXS, DELEGATE)
    expect(f.signed()).toBe(1)
    expect(f.sent).toHaveLength(1)
    expect(f.sent[0]?.to).toBe(ME)
    expect(f.sent[0]?.authorizationList).toHaveLength(1)
  })

  it('already delegated: a plain call to itself, no new authorization', async () => {
    const f = fakes(`0xef0100${DELEGATE.slice(2).toLowerCase()}` as Hex)
    await sendBatch(f.wallet, f.reads, TXS, DELEGATE)
    expect(f.signed()).toBe(0)
    expect(f.sent[0]?.authorizationList).toBeUndefined()
  })

  it('a wallet whose key is elsewhere signs through its registered signer, with the next nonce', async () => {
    const f = fakes('0x')
    let asked: [Address, number, number] | undefined
    setAuthorizationSigner(f.wallet, async (d, c, n) => {
      asked = [d, c, n]
      return { address: d, chainId: c, nonce: n, r: '0x01', s: '0x02', yParity: 1 }
    })
    await sendBatch(f.wallet, f.reads, TXS, DELEGATE)
    expect(asked).toEqual([DELEGATE, 10143, 8])
    expect(f.signed()).toBe(0)
  })

  it('one transaction goes out as it is; a reverted batch throws', async () => {
    const one = fakes('0x')
    await sendBatch(one.wallet, one.reads, [TXS[0] as TxRequest], DELEGATE)
    expect(one.sent[0]?.to).toBe('0x2222222222222222222222222222222222222222')
    const bad = fakes('0x', 'reverted')
    await expect(sendBatch(bad.wallet, bad.reads, TXS, DELEGATE)).rejects.toThrow('approve + publish')
  })
})
