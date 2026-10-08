import { ORIGIN } from './guards.ts'
import { type Hex, parseEther } from 'viem'
import * as sdk from '../../../src/index.ts'
import { HostedBrowser, type ManagedAgent } from './browser.ts'
import { Chain } from './chain.ts'
import { CodingClient, type ToolResult } from './codex.ts'
import { RunState } from './state.ts'

export interface Proof {
  checks: string[]
  txHashes: Hex[]
  details: Record<string, unknown>
}

export function object(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('P8_UNEXPECTED_RESULT_SHAPE')
  return value as Record<string, unknown>
}

export function text(value: unknown): string {
  if (typeof value !== 'string') throw new Error('P8_UNEXPECTED_STRING_RESULT')
  return value
}

export function success(result: ToolResult): Record<string, unknown> {
  const envelope = object(result.output)
  if (result.item.result?.isError === true || envelope.ok !== true) throw new Error('P8_MCP_ACTION_REFUSED')
  return object(envelope.result)
}

export class Runtime {
  readonly chain: Chain
  readonly browser: HostedBrowser

  constructor(readonly run: RunState) {
    this.chain = new Chain(run)
    this.browser = new HostedBrowser(run, this.chain)
  }

  get agent(): ManagedAgent & { address: `0x${string}`; agent_id: string } {
    const agent = this.run.get<ManagedAgent>('managed-agent')
    if (agent === undefined || agent.address === null || agent.agent_id === null)
      throw new Error('P8_A01_MUST_FINISH_FIRST')
    return { ...agent, address: agent.address, agent_id: agent.agent_id }
  }

  async login(): Promise<void> {
    await this.browser.start()
    await this.chain.reserve('operator-login', 100_000n, parseEther('0.05'))
    const operator = await this.browser.login()
    const saved = this.run.get<string>('operator')
    if (saved !== undefined && operator.toLowerCase() !== saved.toLowerCase()) throw new Error('P8_OPERATOR_CHANGED')
    this.run.freeze('operator', operator)
    this.chain.addActor(operator)
    await this.chain.finish('operator-login', await this.browser.cachedHashes())
  }

  async coding(clientId = 'worker'): Promise<CodingClient> {
    const client = new CodingClient(this.run, clientId)
    await client.connect(this.browser, this.agent)
    return client
  }

  async write(
    client: CodingClient,
    name: string,
    args: Record<string, unknown>,
    label: string,
    gas: bigint,
  ): Promise<Record<string, unknown>> {
    const operationKey = `p8-${this.run.get<string>('run-id')}-${label}`
    const intent = this.run.freeze(`intent/${label}`, { ...args, operationKey })
    if (gas > 0n) await this.chain.reserve(label, gas)
    const result = success(await client.call(name, intent, label))
    const status = text(result.status)
    if (status === 'approval') {
      await this.chain.finish(label, [])
      return result
    }
    if (status !== 'confirmed') throw new Error('P8_MCP_OPERATION_REQUIRES_RECONCILIATION')
    const output = object(result.result)
    const sponsorship = output.sponsorship
    const hashes: Hex[] = []
    if (sponsorship !== undefined) {
      const hash = text(object(sponsorship).txHash)
      if (!/^0x[0-9a-fA-F]{64}$/.test(hash)) throw new Error('P8_INVALID_TRANSACTION_HASH')
      hashes.push(hash as Hex)
      const receipt = await this.chain.record(hash as Hex)
      if (receipt.status !== 'success') throw new Error('P8_MCP_RECEIPT_REVERTED')
    }
    if (gas > 0n && hashes.length === 0) throw new Error('P8_MONEY_ACTION_HAS_NO_RECEIPT')
    await this.chain.finish(label, hashes)
    return result
  }

  async creator(): Promise<{ wallet: sdk.Wallet; board: ReturnType<typeof sdk.boardClient> }> {
    const { privateKeyToAccount } = await import('viem/accounts')
    const key = process.env.TESTNET_CREATOR_PRIVATE_KEY
    if (key === undefined) throw new Error('P8_FIXTURE_CREATOR_KEY_MISSING')
    const wallet = sdk.wallet(
      'monad-testnet',
      privateKeyToAccount(key as Hex),
      (process.env.MONAD_RPC_URL ?? process.env.MONAD_TESTNET_RPC_URL)!,
    )
    this.chain.addActor(wallet.account.address)
    const board = sdk.boardClient(ORIGIN)
    await this.chain.reserve('creator-login', 100_000n, parseEther('0.05'))
    await board.signIn(wallet.account as import('viem').LocalAccount)
    await this.chain.finish('creator-login', [])
    return { wallet, board }
  }

  async close(): Promise<void> {
    await this.browser.close()
  }
}
