import { DatabaseSync } from 'node:sqlite'
import * as sdk from '@sidequest/sdk'
import { privateKeyToAccount } from 'viem/accounts'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AgentExecutor } from './agent-executor.ts'
import { AgentSigning } from './agent-signing.ts'
import { assertAgentEnvelope, type AgentTypedData } from './agent-signing-scope.ts'
import { AgentX402, X402Ledger } from './agent-x402.ts'
import { AgentStore } from './agents.ts'
import type { SponsorDesk } from './sponsor.ts'
import { fromNodeSqlite } from './store.ts'
import {
  chooseX402Payment,
  decodeX402Header,
  encodeX402Header,
  x402TypedData,
  X402_DAILY_CAP,
  X402_PAYMENT_CAP,
  type X402Authorization,
  type X402Payload,
} from './x402.ts'

const deployment = sdk.deployment('monad-testnet')
const key = privateKeyToAccount(`0x${'42'.repeat(32)}`)
const payTo = deployment.sidequest!.safe
const clock = 1_800_000_000
const required = (amount = '10000') => ({
  x402Version: 2,
  resource: { url: 'https://tools.example/paid', description: 'A café tool' },
  accepts: [
    {
      scheme: 'exact',
      network: `eip155:${deployment.chainId}`,
      asset: deployment.x402!.usdc,
      amount,
      payTo,
      maxTimeoutSeconds: 120,
      extra: { name: 'USDC', version: '2' },
    },
  ],
})
const authorization: X402Authorization = {
  from: key.address,
  to: payTo,
  value: '10000',
  validAfter: String(clock - 1),
  validBefore: String(clock + 120),
  nonce: `0x${'aa'.repeat(32)}`,
}
const context = { deployment, stack: sdk.stack(deployment, 'main') }
const databases: DatabaseSync[] = []
afterEach(() => {
  for (const db of databases.splice(0)) db.close()
})
const input = (operationKey: string, paymentRequired: unknown = required()) => ({
  agentId: 'payer',
  boardId: 'public',
  tool: 'x402_pay',
  operationKey,
  args: { paymentRequired },
})

function fixture(balance = 100_000_000n) {
  const db = new DatabaseSync(':memory:')
  databases.push(db)
  const sql = fromNodeSqlite(db)
  let time = clock
  const now = () => time
  const agents = new AgentStore(sql, now)
  agents.create({
    id: 'payer',
    operator: payTo,
    privyUserId: 'did:privy:payer',
    name: 'Payer',
    registry: deployment.identity,
    chainId: deployment.chainId,
  })
  agents.bindWallet('payer', 'test-wallet', key.address)
  for (const state of ['upgraded', 'grants-live', 'registered', 'active'] as const) agents.advance('payer', state)
  const readContract = vi.fn(async () => balance)
  const ctx = { ...context, publicClient: { readContract } } as unknown as sdk.Ctx
  const signTypedData = vi.fn(async (_wallet: string, data: string, _requestId: string) => {
    expect(sql.all('SELECT * FROM x402_payments')).not.toHaveLength(0)
    expect(sql.all('SELECT * FROM agent_sign_requests WHERE result_json IS NULL')).not.toHaveLength(0)
    expect(sql.all('SELECT * FROM agent_operation_steps WHERE name=?', 'x402-typed-data')).not.toHaveLength(0)
    return key.signTypedData(JSON.parse(data))
  })
  const provider = {
    signTypedData,
    signAuthorization: async () => {
      throw new Error('unused')
    },
  }
  const signing = new AgentSigning(sql, ctx, provider, now)
  const sponsor = {
    ready: vi.fn(async () => {
      throw new Error('No relay for x402')
    }),
    submit: vi.fn(),
  }
  const deps = {
    sql,
    context: ctx,
    now,
    signing,
    sponsor: sponsor as unknown as SponsorDesk,
    prepareTool: vi.fn(async () => {
      throw new Error('No tenant for x402')
    }),
    verifyToolSigning: async () => {
      throw new Error('unused')
    },
  }
  return {
    sql,
    agents,
    ctx,
    now,
    signing,
    provider,
    signTypedData,
    readContract,
    sponsor,
    deps,
    input,
    executor: new AgentExecutor(deps),
    payments: new AgentX402(deps),
    advance: (seconds: number) => {
      time += seconds
    },
  }
}

describe('x402 exact signing scope', () => {
  it('accepts exactly the configured domain and an agent-funded authorization within ten minutes', () => {
    const data = x402TypedData(deployment, authorization)
    expect(assertAgentEnvelope(context, data, key.address, undefined, clock).primaryType).toBe(
      'TransferWithAuthorization',
    )
    expect(
      assertAgentEnvelope(
        context,
        x402TypedData(deployment, {
          ...authorization,
          value: String(X402_PAYMENT_CAP),
          validAfter: String(clock),
          validBefore: String(clock + 600),
        }),
        key.address,
        undefined,
        clock,
      ),
    ).toBeDefined()
  })

  it.each([
    [
      'domain name',
      (v: AgentTypedData) => {
        v.domain.name = 'USD Coin'
      },
    ],
    [
      'domain version',
      (v: AgentTypedData) => {
        v.domain.version = '1'
      },
    ],
    [
      'chain',
      (v: AgentTypedData) => {
        v.domain.chainId = 143
      },
    ],
    [
      'contract',
      (v: AgentTypedData) => {
        v.domain.verifyingContract = payTo
      },
    ],
    [
      'extra domain field',
      (v: AgentTypedData) => {
        v.domain.salt = sdk.EMPTY_HASH
      },
    ],
    [
      'from',
      (v: AgentTypedData) => {
        v.message.from = payTo
      },
    ],
    [
      'value cap',
      (v: AgentTypedData) => {
        v.message.value = String(X402_PAYMENT_CAP + 1)
      },
    ],
    [
      'negative value',
      (v: AgentTypedData) => {
        v.message.value = '-1'
      },
    ],
    [
      'expiry',
      (v: AgentTypedData) => {
        v.message.validBefore = String(clock + 601)
      },
    ],
    [
      'expired',
      (v: AgentTypedData) => {
        v.message.validBefore = String(clock)
      },
    ],
    [
      'future start',
      (v: AgentTypedData) => {
        v.message.validAfter = String(clock + 1)
      },
    ],
    [
      'nonce',
      (v: AgentTypedData) => {
        v.message.nonce = '0x1234'
      },
    ],
    [
      'schema',
      (v: AgentTypedData) => {
        v.types.TransferWithAuthorization = []
      },
    ],
    [
      'extra type',
      (v: AgentTypedData) => {
        v.types.Permit = []
      },
    ],
    [
      'extra message',
      (v: AgentTypedData) => {
        v.message.token = deployment.x402!.usdc
      },
    ],
    ...['ReceiveWithAuthorization', 'CancelAuthorization', 'Permit'].map(
      (type) =>
        [
          type,
          (v: AgentTypedData) => {
            v.primaryType = type
          },
        ] as const,
    ),
  ] as const)('refuses %s', (_, change) => {
    const data = JSON.parse(x402TypedData(deployment, authorization)) as AgentTypedData
    change(data)
    expect(() => assertAgentEnvelope(context, JSON.stringify(data), key.address, undefined, clock)).toThrow()
  })
})

describe('x402 requirements', () => {
  it('chooses the configured exact entry, preserving it and the UTF-8 resource', () => {
    const payment = required()
    payment.accepts.unshift({ ...payment.accepts[0]!, network: 'eip155:143' })
    const chosen = chooseX402Payment(deployment, encodeX402Header(payment), payment.resource.url)
    expect(chosen.accepted).toEqual(payment.accepts[1])
    expect(chosen.resource).toEqual(payment.resource)
    expect(decodeX402Header(encodeX402Header(payment))).toEqual(payment)
  })

  it.each([
    { asset: payTo },
    { network: 'eip155:143' },
    { scheme: 'upto' },
    { extra: { name: 'USD Coin', version: '2' } },
    { extra: { name: 'USDC', version: '1' } },
    { amount: '-1' },
    { amount: '0' },
    { amount: '1.5' },
    { amount: 10 },
    { amount: String(X402_PAYMENT_CAP + 1) },
    { payTo: 'invalid' },
    { maxTimeoutSeconds: 0 },
  ])('refuses unsupported or malformed requirements %j', (change) => {
    const payment = required()
    expect(() =>
      chooseX402Payment(deployment, { ...payment, accepts: [{ ...payment.accepts[0], ...change }] }),
    ).toThrow()
  })

  it('refuses malformed headers, v1 and a changed resource', () => {
    expect(() => chooseX402Payment(deployment, 'bad base64')).toThrow('base64')
    expect(() => chooseX402Payment(deployment, { ...required(), x402Version: 1 })).toThrow('x402Version')
    expect(() => chooseX402Payment(deployment, required(), 'https://other.example/paid')).toThrow('resource differs')
  })
})

describe('agent-funded payment journal and ledger on SQLite', () => {
  it('persists before signing and recovers the same nonce/header after executor restarts and expiry', async () => {
    const f = fixture()
    const request = f.input('one', encodeX402Header(required()))
    const first = await f.executor.execute(request)
    if (first.status !== 'confirmed') throw new Error('Expected confirmed payment')
    const result = first.result as Awaited<ReturnType<AgentX402['pay']>>
    expect(decodeX402Header(result.paymentSignatureHeader)).toEqual(result.payload)
    expect(result.payload.accepted.amount).toBe('10000')
    expect(result.ledger).toEqual({ usedToday: 10000, cap: X402_DAILY_CAP })
    f.advance(1000)
    expect(await new AgentExecutor(f.deps).execute(request)).toEqual(first)
    expect(
      await f.signing.signX402(
        'payer',
        first.operationId,
        x402TypedData(deployment, result.payload.payload.authorization),
      ),
    ).toBe(result.payload.payload.signature)
    expect(f.signTypedData).toHaveBeenCalledTimes(1)
    expect(f.readContract).toHaveBeenCalledWith({
      address: deployment.x402!.usdc,
      abi: expect.any(Array),
      functionName: 'balanceOf',
      args: [key.address.toLowerCase()],
    })
    expect(f.sponsor.ready).not.toHaveBeenCalled()
    expect(f.deps.prepareTool).not.toHaveBeenCalled()
    await expect(
      f.executor.execute({ ...request, args: { paymentRequired: required('20000') } }),
    ).rejects.toMatchObject({ reason: 'operation-key-reused' })
  })

  it('recovers a lost provider response with the original provider key and reservation', async () => {
    const f = fixture()
    f.signTypedData.mockRejectedValueOnce(new Error('Response lost'))
    await expect(f.executor.execute(f.input('lost'))).rejects.toThrow('Response lost')
    const request = f.sql.all<{ request_json: string; id: string }>('SELECT * FROM agent_sign_requests')[0]!
    expect(new X402Ledger(f.sql, f.now).usedToday('payer')).toBe(10000)
    f.advance(10)
    const nextSigning = new AgentSigning(f.sql, f.ctx, f.provider, f.now)
    await new AgentExecutor({ ...f.deps, signing: nextSigning }).execute(f.input('lost'))
    expect(f.signTypedData.mock.calls[0]).toEqual(f.signTypedData.mock.calls[1])
    expect(f.signTypedData.mock.calls[1]![2]).toBe(request.id)
    expect(f.sql.all('SELECT * FROM x402_payments')).toHaveLength(1)
    expect(f.readContract).toHaveBeenCalledTimes(1)
  })

  it('recovers a crash after marking the result sending without signing again', async () => {
    const f = fixture()
    const first = await f.executor.execute(f.input('sending'))
    f.sql.run("UPDATE agent_operations SET stage='sending',result_json=NULL WHERE id=?", first.operationId)
    expect(await new AgentExecutor(f.deps).execute(f.input('sending'))).toEqual(first)
    expect(f.signTypedData).toHaveBeenCalledTimes(1)
  })

  it('refuses insufficient USDC before reserving or signing, and gives an operator funding hint', async () => {
    const f = fixture(9999n)
    await expect(f.executor.execute(f.input('empty'))).rejects.toMatchObject({
      reason: 'insufficient-funds',
      retry: 'after-operator',
      message: expect.stringContaining('erc20-token-periodic'),
    })
    expect(f.sql.all('SELECT * FROM x402_payments')).toHaveLength(0)
    expect(f.signTypedData).not.toHaveBeenCalled()
  })

  it('caps every signed payment across a rolling day, counts reservations, and isolates agents', async () => {
    const f = fixture()
    for (let i = 0; i < 4; i++) await f.executor.execute(f.input(`payment-${i}`, required(String(X402_PAYMENT_CAP))))
    const ledger = new X402Ledger(f.sql, f.now)
    expect(ledger.usedToday('payer')).toBe(X402_DAILY_CAP)
    expect(ledger.usedToday('another-agent')).toBe(0)
    await expect(f.executor.execute(f.input('over', required('1')))).rejects.toMatchObject({
      reason: 'cap',
      retry: 'after-operator',
    })
    f.advance(86_399)
    await expect(f.executor.execute(f.input('over', required('1')))).rejects.toMatchObject({ reason: 'cap' })
    f.advance(1)
    expect(await f.executor.execute(f.input('over', required('1')))).toMatchObject({
      status: 'confirmed',
      result: { ledger: { usedToday: 1 } },
    })
    expect(f.signTypedData).toHaveBeenCalledTimes(5)
  })

  it('refuses a nonce collision and changed frozen data instead of signing another payment', async () => {
    const f = fixture()
    const first = await f.executor.execute(f.input('one'))
    if (first.status !== 'confirmed') throw new Error('Expected confirmed payment')
    const payload = (first.result as { payload: X402Payload }).payload
    const row = f.sql.all<{
      nonce: string
      agent_id: string
      operation_id: `0x${string}`
      asset: string
      pay_to: string
      value: string
      valid_before: number
      resource: string
    }>('SELECT * FROM x402_payments')[0]!
    const ledger = new X402Ledger(f.sql, f.now)
    expect(() =>
      ledger.reserve({
        nonce: row.nonce as `0x${string}`,
        agent_id: row.agent_id,
        operation_id: sdk.EMPTY_HASH,
        asset: row.asset,
        pay_to: row.pay_to,
        value: row.value,
        valid_before: row.valid_before,
        resource: row.resource,
      }),
    ).toThrow()
    await expect(
      f.signing.signX402(
        'payer',
        first.operationId,
        x402TypedData(deployment, { ...payload.payload.authorization, value: '1' }),
      ),
    ).rejects.toThrow('frozen authorized action')
    expect(f.signTypedData).toHaveBeenCalledTimes(1)
  })

  it('anchors the rolling window to the recovered signature time and does not extend it on retries', async () => {
    const f = fixture()
    f.signTypedData.mockRejectedValueOnce(new Error('Response lost'))
    await expect(f.executor.execute(f.input('delayed'))).rejects.toThrow()
    f.advance(60)
    await f.executor.execute(f.input('delayed'))
    const ledger = new X402Ledger(f.sql, f.now)
    f.advance(86_340)
    expect(ledger.usedToday('payer')).toBe(10000)
    await f.executor.execute(f.input('delayed'))
    f.advance(60)
    expect(ledger.usedToday('payer')).toBe(0)
    expect(f.signTypedData).toHaveBeenCalledTimes(2)
  })

  it('never signs an expired uncertain authorization and cannot execute on mainnet', async () => {
    const f = fixture()
    f.signTypedData.mockRejectedValueOnce(new Error('Response lost'))
    await expect(f.executor.execute(f.input('expired'))).rejects.toThrow()
    f.advance(121)
    await expect(f.executor.execute(f.input('expired'))).rejects.toThrow('signing window')
    const mainnet = { ...f.ctx, deployment: { ...deployment, network: 'monad-mainnet', chainId: 143 } } as sdk.Ctx
    await expect(new AgentExecutor({ ...f.deps, context: mainnet }).execute(f.input('mainnet'))).rejects.toMatchObject({
      reason: 'outside-policy',
      retry: 'none',
    })
    expect(f.signTypedData).toHaveBeenCalledTimes(1)
  })
})
