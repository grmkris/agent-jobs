/** P0's private journal and bounded testnet-only relay. No provider error bodies escape. */
import { existsSync, mkdirSync, openSync, closeSync, fsyncSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { type Address, type Hex, type SignedAuthorization, type TransactionReceipt, parseEther } from 'viem'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'
import { context, wallet } from '../../src/client.ts'
import { type FlowState, FlowJournal, flowJson, parseFlowJson } from '../../src/flow-journal.ts'
import { delegationOf } from '../../src/batch.ts'
import { delegationTypedData, type Delegation } from '../../../board/src/delegation.ts'
import { PrivyApi } from '../privy/client.ts'
import { appendEnv, envPath, required } from '../privy/env.ts'
import { config, schema, signingShapes } from '../privy/policy.ts'
import { spentAndReserved } from './authority-cost.ts'

const directory = new URL('./.local/', import.meta.url)
const path = new URL('chain.json', directory)
// A per-run guard below the relay's 10 MON daily policy; the 2 MON reserve remains untouched.
const RUN_CAP = parseEther('1')
const RESERVE = parseEther('2')

export interface ChainReceipt {
  label: string
  hash: Hex
  gasLimit: string
  gasUsed: string
  effectiveGasPrice: string
  costWei: string
  blockNumber: string
  timestamp: string
  relayNonce: number
}

function writePrivate(state: FlowState): void {
  mkdirSync(directory, { recursive: true, mode: 0o700 })
  const temporary = new URL('chain.json.tmp', directory)
  const fd = openSync(temporary, 'w', 0o600)
  try {
    writeFileSync(fd, `${flowJson(state)}\n`)
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
  renameSync(temporary, path)
  const directoryFd = openSync(directory, 'r')
  try { fsyncSync(directoryFd) } finally { closeSync(directoryFd) }
}

export class AuthorityChain {
  readonly ctx
  readonly relay
  readonly operator
  readonly journal: FlowJournal
  readonly receipts: ChainReceipt[]
  stage = 'initialization'

  constructor(readonly runId: string, readonly agent: Address, readonly walletId: string,
    readonly api: PrivyApi, readonly sign: (payload: string) => Promise<string>, env: Record<string, string>) {
    const rpc = required(env, 'MONAD_TESTNET_RPC_URL')
    this.ctx = context('monad-testnet', 'main', rpc)
    this.relay = wallet('monad-testnet', privateKeyToAccount(required(env, 'RELAY_PRIVATE_KEY') as Hex), rpc)
    if (this.relay.account.address.toLowerCase() !== config.roles.relay.toLowerCase()) throw new Error('Relay key/config mismatch')
    const state: FlowState = existsSync(path) ? parseFlowJson(readFileSync(path, 'utf8')) : {
      binding: `${runId}:${agent.toLowerCase()}`, values: {}, sends: {},
    }
    if (state.binding !== `${runId}:${agent.toLowerCase()}`) throw new Error('Chain fixture binding mismatch')
    const journalKey = state.values.operatorKey as Hex | undefined
    const operatorKey = env.P0_FIXTURE_OPERATOR_PRIVATE_KEY ?? journalKey ?? generatePrivateKey()
    if (journalKey !== undefined && journalKey !== operatorKey) throw new Error('Fixture operator key mismatch')
    appendEnv(envPath, 'P0_FIXTURE_OPERATOR_PRIVATE_KEY', operatorKey)
    this.operator = privateKeyToAccount(operatorKey as Hex)
    if (state.values.operatorAddress !== undefined && state.values.operatorAddress !== this.operator.address) throw new Error('Fixture operator address mismatch')
    state.values.operatorAddress = this.operator.address
    delete state.values.operatorKey
    this.receipts = (state.values.receipts ?? []) as ChainReceipt[]
    state.values.receipts = this.receipts
    this.journal = new FlowJournal(this.ctx, state, (current) => {
      const reserved = spentAndReserved(current)
      if (reserved > RUN_CAP) throw new Error('P0 relay run cap exceeded; nothing new was broadcast')
      writePrivate(current)
    }, () => {})
    writePrivate(state)
  }

  async initialize(): Promise<void> {
    if (await this.ctx.publicClient.getChainId() !== 10143) throw new Error('P0 RPC must be testnet 10143')
    for (const address of [this.ctx.deployment.identity, this.ctx.deployment.delegation.manager,
      this.ctx.deployment.delegation.delegator, config.delegation.enforcers.erc20PeriodTransfer]) {
      if (((await this.ctx.publicClient.getCode({ address })) ?? '0x') === '0x') throw new Error('Configured proof contract has no code')
    }
  }

  async send(label: string, to: Address, data: Hex, gas: bigint, authorizationList?: SignedAuthorization<number>[]): Promise<TransactionReceipt> {
    this.stage = label
    const balance = await this.ctx.publicClient.getBalance({ address: this.relay.account.address })
    if (balance < RESERVE + RUN_CAP) throw new Error('Relay reserve would be at risk')
    const receipt = await this.journal.send(label, this.relay, { to, data, value: '0', gas: gas.toString() }, authorizationList)
    if (!this.receipts.some(item => item.hash === receipt.transactionHash)) {
      const tx = await this.ctx.publicClient.getTransaction({ hash: receipt.transactionHash })
      const block = await this.ctx.publicClient.getBlock({ blockNumber: receipt.blockNumber })
      this.receipts.push({ label, hash: receipt.transactionHash, gasLimit: tx.gas.toString(), gasUsed: receipt.gasUsed.toString(),
        effectiveGasPrice: receipt.effectiveGasPrice.toString(), costWei: (receipt.gasUsed * receipt.effectiveGasPrice).toString(),
        blockNumber: receipt.blockNumber.toString(), timestamp: block.timestamp.toString(), relayNonce: tx.nonce })
      this.journal.save(this.journal.state)
      console.log(`${label}: ${receipt.transactionHash} gas=${receipt.gasUsed}`)
    }
    return receipt
  }

  async operatorGrant(label: string, make: () => Promise<Delegation>): Promise<Delegation> {
    return this.journal.once(label, async () => {
      const grant = await make()
      const typed = JSON.parse(delegationTypedData(this.ctx.deployment, grant))
      return { ...grant, signature: await this.operator.signTypedData(typed) }
    })
  }

  async agentTyped(label: string, primaryType: string, message: Record<string, unknown>): Promise<Hex> {
    this.stage = label
    return this.journal.once(label, async () => {
      const shape = signingShapes.find(item => item.primaryType === primaryType)
      if (!shape) throw new Error('Unapproved typed-data shape')
      if (primaryType === 'Delegation' && message.delegate !== config.roles.relay) throw new Error('Wrong fixture delegate')
      if (primaryType === 'AgentWalletSet' && message.newWallet !== this.agent) throw new Error('Wrong fixture newWallet')
      const body = { method: 'eth_signTypedData_v4', params: { typed_data: {
        ...schema(shape), domain: { name: shape.name, version: '1', chainId: 10143, verifyingContract: shape.contract }, message,
      } } }
      const response = await this.api.checked('POST', `/wallets/${this.walletId}/rpc`, body, this.sign, `${this.runId}:${label}`)
      const data = response.data as { signature: Hex }
      if (!/^0x[0-9a-fA-F]{130}$/.test(data.signature)) throw new Error('Privy returned no fixture signature')
      return data.signature
    })
  }

  async agentGrant(label: string, make: () => Promise<Delegation>): Promise<Delegation> {
    const grant = await this.journal.once(`${label}/grant`, make)
    const typed = JSON.parse(delegationTypedData(this.ctx.deployment, grant))
    return { ...grant, signature: await this.agentTyped(`${label}/signature`, 'Delegation', typed.message) }
  }

  async upgrades(): Promise<void> {
    const delegate = this.ctx.deployment.delegation.delegator
    const operatorAuth = await this.journal.once('operator/authorization', async () => this.operator.signAuthorization({
      contractAddress: delegate, chainId: 10143,
      nonce: await this.ctx.publicClient.getTransactionCount({ address: this.operator.address, blockTag: 'pending' }),
    }))
    await this.send('operator/upgrade', this.operator.address, '0x', 100_000n, [operatorAuth])
    const agentAuth = await this.journal.once('agent/authorization', async () => {
      const nonce = await this.ctx.publicClient.getTransactionCount({ address: this.agent, blockTag: 'pending' })
      const response = await this.api.checked('POST', `/wallets/${this.walletId}/rpc`, {
        method: 'eth_sign7702Authorization', params: { contract: delegate, chain_id: 10143, nonce },
      }, this.sign, `${this.runId}:agent-upgrade`)
      const a = (response.data as { authorization: Record<string, string | number> }).authorization
      return { address: (a.contract ?? a.address) as Address, chainId: Number(a.chain_id), nonce: Number(a.nonce),
        r: a.r as Hex, s: a.s as Hex, yParity: Number(a.y_parity) }
    })
    if (agentAuth.address.toLowerCase() !== delegate.toLowerCase() || agentAuth.chainId !== 10143) throw new Error('Wrong Privy authorization scope')
    await this.send('agent/upgrade', this.agent, '0x', 100_000n, [agentAuth])
    for (const account of [this.operator.address, this.agent]) {
      if ((await delegationOf(this.ctx.publicClient, account))?.toLowerCase() !== delegate.toLowerCase()) throw new Error('Fixture upgrade did not take effect')
    }
  }

  async expectedRevert(label: string, data: Hex, reason: string): Promise<void> {
    this.stage = label
    try {
      await this.ctx.publicClient.call({ account: this.relay.account, to: this.ctx.deployment.delegation.manager, data })
    } catch (error) {
      if (String(error).includes(reason)) return
      throw new Error(`${label}: expected contract refusal was not proven`, { cause: error })
    }
    throw new Error(`${label}: contract unexpectedly accepted the forbidden execution`)
  }

  async waitUntil(timestamp: number): Promise<void> {
    while (Number((await this.ctx.publicClient.getBlock()).timestamp) < timestamp) {
      console.log(`P0.5 waiting for testnet timestamp ${timestamp}`)
      await new Promise(resolve => setTimeout(resolve, 15_000))
    }
  }

  summary() {
    return { operator: this.operator.address, agent: this.agent, relay: this.relay.account.address,
      runCapWei: RUN_CAP.toString(), reserveWei: RESERVE.toString(), configuredDailyBudgetWei: parseEther('10').toString(),
      totalCostWei: this.receipts.reduce((sum, receipt) => sum + BigInt(receipt.costWei), 0n).toString(), transactions: this.receipts }
  }
}
