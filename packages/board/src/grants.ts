/** Immutable prepared grant templates and signed bytes. Chain counters remain the authority for availability. */
import * as sdk from '@agent-jobs/sdk'
import { type Address, type Hex, recoverAddress } from 'viem'
import { migrateAgentSchema } from './agent-schema.ts'
import type { Sql } from './store.ts'

export interface GrantRow {
  delegation_hash: Hex
  kind: sdk.GrantKind
  delegator: Address
  delegate: Address
  owner: Address
  delegation_json: string
  signature: Hex | null
  status: 'prepared' | 'live' | 'revoked' | 'disabled'
  expires_at: number
}

export function grantSpecJson(spec: sdk.GrantSpec): string {
  return JSON.stringify(spec, (_, value) => typeof value === 'bigint' ? value.toString() : value)
}

export function parseGrantSpec(json: string): sdk.GrantSpec {
  const raw = JSON.parse(json) as sdk.GrantSpec & { salt: string; amount?: string }
  return { ...raw, salt: BigInt(raw.salt), ...(raw.amount === undefined ? {} : { amount: BigInt(raw.amount) }) } as sdk.GrantSpec
}

export class GrantStore {
  constructor(readonly sql: Sql, readonly context: sdk.GrantContext) {
    migrateAgentSchema(sql)
  }

  prepare(owner: Address, spec: sdk.GrantSpec): { hash: Hex; grant: sdk.Delegation; typedData: string; description: ReturnType<typeof sdk.describeGrant> } {
    const grant = sdk.buildGrant(this.context, spec)
    const hash = sdk.delegationHash(grant)
    const prior = this.get(hash)
    if (prior && (prior.owner.toLowerCase() !== owner.toLowerCase() || prior.status === 'revoked' || prior.status === 'disabled')) throw new Error('Grant identity is already stopped')
    if (this.sql.atomic === undefined) throw new Error('Grant preparation requires atomic storage')
    this.sql.atomic(() => {
      this.sql.run(`INSERT OR IGNORE INTO grants (delegation_hash,kind,delegator,delegate,owner,delegation_json,signature,status,expires_at)
        VALUES (?,?,?,?,?,?,NULL,'prepared',?)`, hash, spec.kind, grant.delegator.toLowerCase(), grant.delegate.toLowerCase(), owner.toLowerCase(), sdk.delegationJson(grant), sdk.grantExpiry(spec))
      this.sql.run('INSERT OR IGNORE INTO grant_templates VALUES (?,?)', hash, grantSpecJson(spec))
    })
    return { hash, grant, typedData: sdk.delegationTypedData(this.context.deployment, grant), description: sdk.describeGrant(this.context, spec, grant) }
  }

  get(hash: Hex): GrantRow | undefined {
    return this.sql.all<GrantRow>('SELECT * FROM grants WHERE delegation_hash=?', hash)[0]
  }

  spec(hash: Hex): sdk.GrantSpec {
    const row = this.sql.all<{ spec_json: string }>('SELECT spec_json FROM grant_templates WHERE delegation_hash=?', hash)[0]
    if (!row) throw new Error('Missing grant template')
    return parseGrantSpec(row.spec_json)
  }

  list(wallet: Address): GrantRow[] {
    return this.sql.all<GrantRow>('SELECT * FROM grants WHERE delegator=? ORDER BY expires_at DESC', wallet.toLowerCase())
  }

  signed(hash: Hex): sdk.Delegation {
    const row = this.get(hash)
    if (!row || row.signature === null || row.status !== 'live') throw new Error('Grant is not live')
    const grant = { ...sdk.parseDelegation(row.delegation_json), signature: row.signature }
    sdk.assertGrant(this.context, this.spec(hash), grant)
    return grant
  }

  async confirm(hash: Hex, signature: Hex): Promise<GrantRow> {
    const row = this.get(hash)
    if (!row || !['prepared', 'live'].includes(row.status)) throw new Error('Grant is not available for confirmation')
    const grant = sdk.parseDelegation(row.delegation_json)
    sdk.assertGrant(this.context, this.spec(hash), grant)
    const signer = await recoverAddress({ hash: sdk.delegationDigest(this.context.deployment, grant), signature })
    if (signer.toLowerCase() !== row.delegator.toLowerCase()) throw new Error('Grant signature is not the delegator')
    if (row.signature !== null && row.signature.toLowerCase() !== signature.toLowerCase()) throw new Error('Grant signature changed')
    this.sql.run("UPDATE grants SET signature=?,status='live' WHERE delegation_hash=?", signature, hash)
    return this.get(hash)!
  }

  stop(hash: Hex): void {
    this.sql.run("UPDATE grants SET status='revoked' WHERE delegation_hash=? AND status!='disabled'", hash)
  }
}
