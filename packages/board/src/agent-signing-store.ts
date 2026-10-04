/** The request bytes and provider idempotency key exist before a signing call can start. */
import { type Hex, keccak256, stringToHex } from 'viem'
import { canonicalAgentArgs } from './agents.ts'
import type { Sql } from './store.ts'

export interface AgentSignRequest {
  id: Hex
  request_json: string
  result_json: string | null
}

export function prepareAgentSignRequest(sql: Sql, input: { agentId: string; purpose: string; walletId: string; request: unknown; now: number }): AgentSignRequest {
  const id = keccak256(stringToHex(canonicalAgentArgs([input.agentId, input.purpose])))
  const request = canonicalAgentArgs(input.request)
  sql.run(`INSERT OR IGNORE INTO agent_sign_requests (id,agent_id,purpose,wallet_id,request_json,created_at) VALUES (?,?,?,?,?,?)`,
    id, input.agentId, input.purpose, input.walletId, request, input.now)
  const row = sql.all<AgentSignRequest & { wallet_id: string }>('SELECT * FROM agent_sign_requests WHERE id=?', id)[0]!
  if (row.request_json !== request || row.wallet_id !== input.walletId) throw new Error('Persisted signer request cannot change')
  return row
}

export function finishAgentSignRequest(sql: Sql, request: AgentSignRequest, result: unknown): unknown {
  const json = canonicalAgentArgs(result)
  sql.run('UPDATE agent_sign_requests SET result_json=? WHERE id=? AND result_json IS NULL', json, request.id)
  const row = sql.all<AgentSignRequest>('SELECT * FROM agent_sign_requests WHERE id=?', request.id)[0]!
  if (row.result_json !== json) throw new Error('Provider returned a different signature for the persisted request')
  return JSON.parse(row.result_json)
}
