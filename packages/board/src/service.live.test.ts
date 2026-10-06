/**
 * The board service against the contracts deployed on Monad testnet, read-only: sign-in, offer creation and the
 * transactions it prepares, and the admission check against the real ERC-8004 registry. Nothing is sent. Skipped
 * without MONAD_TESTNET_RPC_URL.
 */
import { DatabaseSync } from 'node:sqlite'
import * as sdk from '@sidequest/sdk'
import { decodeFunctionData, parseUnits } from 'viem'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'
import { beforeAll, describe, expect, it } from 'vitest'
import { Board, BoardError, fromNodeSqlite } from './index.ts'

const rpc = process.env.MONAD_TESTNET_RPC_URL
const live = rpc === undefined || rpc === '' ? describe.skip : describe

live('board service on monad-testnet (read-only)', () => {
  let board: Board
  beforeAll(() => {
    const legacyDemo = sdk.deployment('monad-testnet').legacyStacks['demo-v2']!
    board = new Board(fromNodeSqlite(new DatabaseSync(':memory:')), {
      network: 'monad-testnet',
      contexts: {
        main: sdk.context('monad-testnet', 'main', rpc ?? ''),
        demo: sdk.contextFor('monad-testnet', legacyDemo, rpc ?? ''),
      },
      domain: 'board.test',
      uri: 'https://board.test',
      manifestBaseUrl: 'https://board.test/offers',
    })
  })
  const creator = privateKeyToAccount(generatePrivateKey())

  async function signIn(account = creator) {
    const { message } = board.authChallenge({ address: account.address })
    const signature = await account.signMessage({ message })
    return board.authLogin({ message, signature })
  }

  it('signs in with SIWE once per challenge', async () => {
    const { message } = board.authChallenge({ address: creator.address })
    const signature = await creator.signMessage({ message })
    const session = await board.authLogin({ message, signature })
    expect(board.sessionAddress(session.session)).toBe(creator.address)
    await expect(board.authLogin({ message, signature })).rejects.toThrow(BoardError)
    const other = privateKeyToAccount(generatePrivateKey())
    const { message: m2 } = board.authChallenge({ address: creator.address })
    await expect(board.authLogin({ message: m2, signature: await other.signMessage({ message: m2 }) })).rejects.toThrow(
      'signature',
    )
  })

  it('creates an offer and prepares approvals and a publish that encodes exactly the offer', async () => {
    const { address } = await signIn()
    const deliveryDeadline = Math.floor(Date.now() / 1000) + 3600
    const created = await board.createTask(
      { address },
      {
        title: 'Add CI to runner-spike-fixture',
        brief: 'Run the tests on push and PR.',
        acceptanceCriteria: ['a check named "test" passes on the submitted SHA'],
        token: 'mEUR',
        reward: '25',
        creatorBond: '5',
        workerBond: '3',
        deliveryDeadline,
        mode: 'hire',
        stack: 'demo',
      },
    )
    expect(created.transactions.map((t) => t.description)).toEqual([
      'approve reward token for JobHolding',
      'approve SIDE (creator bond) for JobHolding',
      'publish: escrows the reward and the creator bond and lists the offer',
    ])
    const publish = created.transactions[2]!
    const { functionName, args } = decodeFunctionData({ abi: sdk.jobHoldingAbi, data: publish.data })
    expect(functionName).toBe('publish')
    const p = (args as unknown as [{ policyHash: string; reward: bigint; deliveryDeadline: number }])[0]
    expect(p.policyHash).toBe(created.termsHash)
    expect(p.reward).toBe(parseUnits('25', 6))
    expect(p.deliveryDeadline).toBe(deliveryDeadline)
    const task = await board.getTask({ address }, { taskId: created.taskId })
    expect(task.chain.status).toBe('awaiting-publish')
    expect(task.you).toEqual(['creator', 'approver'])
  })

  it('refuses a stack windows mismatch and an unknown token', async () => {
    const { address } = await signIn()
    const base = {
      title: 't',
      brief: 'b',
      acceptanceCriteria: [],
      reward: '1',
      creatorBond: '0',
      workerBond: '0',
      deliveryDeadline: Math.floor(Date.now() / 1000) + 3600,
      mode: 'hire' as const,
      stack: 'demo' as const,
    }
    await expect(board.createTask({ address }, { ...base, token: 'DOGE' })).rejects.toThrow('not a known token symbol')
    await expect(board.createTask({ address }, { ...base, token: 'mUSD', mode: 'contest', selectionDeadline: 1 })).rejects.toThrow(
      BoardError,
    )
  })

  it('quote requests: public, nothing escrowed; quotes only from registered agents in an accepted token', async () => {
    const { address } = await signIn()
    const now = Math.floor(Date.now() / 1000)
    const req = await board.requestQuotes(
      { address },
      {
        title: 'quote me',
        brief: 'b',
        acceptanceCriteria: ['c'],
        tokens: ['mEUR'],
        creatorBond: '1',
        workerBond: '1',
        deliveryDeadline: now + 3600,
        quoteDeadline: now + 600,
        stack: 'demo',
      },
    )
    expect(req.status).toBe('Accepting quotes — reward not escrowed')
    expect(board.listQuoteRequests({}).map((r) => r.requestId)).toContain(req.requestId)
    const bidder = privateKeyToAccount(generatePrivateKey())
    const { address: b } = await signIn(bidder)
    await expect(board.submitQuote({ address: b }, { requestId: req.requestId, agentId: '1939', token: 'mUSD', amount: '5' })).rejects.toThrow('not accepted')
    await expect(board.submitQuote({ address: b }, { requestId: req.requestId, agentId: '1939', token: 'mEUR', amount: '5' })).rejects.toThrow('registered wallet')
    await expect(board.pickQuote({ address: b }, { requestId: req.requestId, quoteId: 'x' })).rejects.toThrow('only the requester')
    await expect(
      board.requestQuotes({ address }, { title: 't', brief: 'b', acceptanceCriteria: [], tokens: ['mEUR'], creatorBond: '0', workerBond: '0', deliveryDeadline: now + 60, quoteDeadline: now + 120, stack: 'demo' }),
    ).rejects.toThrow('quote deadline')
  })

  it('requires sign-in for writes', async () => {
    await expect(
      board.createTask({}, { title: '', brief: '', acceptanceCriteria: [], token: 'mUSD', reward: '1', creatorBond: '0', workerBond: '0', deliveryDeadline: 0, mode: 'hire' }),
    ).rejects.toThrow('Sign in')
  })
})
