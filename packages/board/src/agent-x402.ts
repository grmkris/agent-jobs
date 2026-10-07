/** The management object's rolling ledger reserves authority before an uncertain provider call. */
import type * as sdk from '@sidequest/sdk'
import { type Hex, erc20Abi } from 'viem'
import { AgentFailure } from './agent-failure.ts'
import { AgentStore, type AgentOperationRow } from './agents.ts'
import type { AgentSigning } from './agent-signing.ts'
import type { Sql } from './store.ts'
import {
  chooseX402Payment,
  encodeX402Header,
  x402Deployment,
  x402TypedData,
  X402_DAILY_CAP,
  type X402Authorization,
  type X402Payload,
} from './x402.ts'

interface PaymentRow {
  nonce: Hex
  agent_id: string
  operation_id: Hex
  asset: string
  pay_to: string
  value: string
  valid_before: number
  resource: string
  created_at: number
}

export class X402Ledger {
  constructor(
    readonly sql: Sql,
    readonly now: () => number,
  ) {
    sql.run(`CREATE TABLE IF NOT EXISTS x402_payments (
      nonce TEXT PRIMARY KEY, agent_id TEXT NOT NULL, operation_id TEXT NOT NULL UNIQUE,
      asset TEXT NOT NULL, pay_to TEXT NOT NULL, value TEXT NOT NULL, valid_before INTEGER NOT NULL,
      resource TEXT NOT NULL, created_at INTEGER NOT NULL
    )`)
    sql.run('CREATE INDEX IF NOT EXISTS x402_payments_agent_time ON x402_payments(agent_id,created_at)')
  }

  usedToday(agentId: string): number {
    return this.sql.all<{ total: number }>(
      'SELECT coalesce(sum(CAST(value AS INTEGER)),0) AS total FROM x402_payments WHERE agent_id=? AND created_at>?',
      agentId,
      this.now() - 86_400,
    )[0]!.total
  }

  check(agentId: string, amount: string): void {
    if (BigInt(this.usedToday(agentId)) + BigInt(amount) > BigInt(X402_DAILY_CAP))
      throw new AgentFailure(
        'forbidden',
        'The agent has reached its rolling 24-hour x402 cap of 20 USDC',
        'cap',
        'after-operator',
      )
  }

  reserve(row: Omit<PaymentRow, 'created_at'>): void {
    if (this.sql.atomic === undefined) throw new Error('x402 ledger requires atomic storage')
    this.sql.atomic(() => {
      const prior = this.sql.all<PaymentRow>('SELECT * FROM x402_payments WHERE operation_id=?', row.operation_id)[0]
      if (prior !== undefined) {
        for (const key of Object.keys(row) as Array<keyof typeof row>)
          if (prior[key] !== row[key]) throw new Error('Persisted x402 payment cannot change')
        return
      }
      this.check(row.agent_id, row.value)
      this.sql.run(
        'INSERT INTO x402_payments (nonce,agent_id,operation_id,asset,pay_to,value,valid_before,resource,created_at) VALUES (?,?,?,?,?,?,?,?,?)',
        row.nonce,
        row.agent_id,
        row.operation_id,
        row.asset,
        row.pay_to,
        row.value,
        row.valid_before,
        row.resource,
        this.now(),
      )
    })
  }
}

export class AgentX402 {
  readonly ledger: X402Ledger
  readonly agents: AgentStore

  constructor(readonly deps: { sql: Sql; context: sdk.Ctx; signing: AgentSigning; now: () => number }) {
    this.agents = new AgentStore(deps.sql, deps.now)
    this.ledger = new X402Ledger(deps.sql, deps.now)
  }

  async pay(operation: AgentOperationRow): Promise<{
    paymentSignatureHeader: string
    payload: X402Payload
    validBefore: string
    ledger: { usedToday: number; cap: number }
  }> {
    const { context, signing, now } = this.deps
    const config = x402Deployment(context.deployment)
    const agent = this.agents.get(operation.agent_id)
    if (operation.tool !== 'x402_pay' || agent.state !== 'active' || agent.address === null)
      throw new AgentFailure('forbidden', 'x402 requires an active agent payment operation', 'outside-policy', 'none')
    const args = JSON.parse(operation.intent_json) as Record<string, unknown>
    const chosen = chooseX402Payment(context.deployment, args.paymentRequired, args.resource)
    let authorization = this.agents.step<X402Authorization>(operation.id, 'x402-authorization')
    if (authorization === undefined) {
      this.ledger.check(agent.id, chosen.accepted.amount)
      const balance = await context.publicClient.readContract({
        address: config.usdc,
        abi: erc20Abi,
        functionName: 'balanceOf',
        args: [agent.address],
      })
      if (balance < BigInt(chosen.accepted.amount))
        throw new AgentFailure(
          'conflict',
          'Fund this agent wallet with USDC first, for example with an erc20-token-periodic permission paying the agent',
          'insufficient-funds',
          'after-operator',
        )
      authorization = this.agents.freezeStep(operation.id, 'x402-authorization', {
        from: agent.address,
        to: chosen.accepted.payTo,
        value: chosen.accepted.amount,
        validAfter: String(Math.max(0, now() - 1)),
        validBefore: String(now() + Math.min(chosen.accepted.maxTimeoutSeconds, 600)),
        nonce:
          `0x${Array.from(crypto.getRandomValues(new Uint8Array(32)), (byte) => byte.toString(16).padStart(2, '0')).join('')}` as Hex,
      })
    }
    this.ledger.reserve({
      nonce: authorization.nonce,
      agent_id: agent.id,
      operation_id: operation.id,
      asset: chosen.accepted.asset,
      pay_to: authorization.to,
      value: authorization.value,
      valid_before: Number(authorization.validBefore),
      resource: chosen.resource.url,
    })
    const signature = await signing.signX402(agent.id, operation.id, x402TypedData(context.deployment, authorization))
    const payload: X402Payload = { x402Version: 2, ...chosen, payload: { signature, authorization } }
    return {
      paymentSignatureHeader: encodeX402Header(payload),
      payload,
      validBefore: authorization.validBefore,
      ledger: { usedToday: this.ledger.usedToday(agent.id), cap: X402_DAILY_CAP },
    }
  }
}
