/** The agent-first clean break is atomic and runs once in each existing object. */
import type { Sql } from './store.ts'

export const RETIRED_FLEET_TABLES = [
  'managed_agents', 'agent_pairings', 'agent_approvals', 'agent_activity',
  'oauth_clients', 'oauth_requests', 'oauth_codes', 'oauth_tokens',
  'oauth_tokens_v2', 'oauth_token_families_v2', 'oauth_token_families',
  'agent_gateway_operations', 'approval_execution', 'agent_challenges', 'agent_runtime',
] as const

function transition(sql: Sql, name: string, tables: readonly string[], create: () => void): void {
  if (sql.atomic === undefined) throw new Error('Agent schema transition requires atomic storage')
  sql.atomic(() => {
    sql.run('CREATE TABLE IF NOT EXISTS schema_versions (name TEXT PRIMARY KEY, version INTEGER NOT NULL)')
    const row = sql.all<{ version: number }>('SELECT version FROM schema_versions WHERE name=?', name)[0]
    if (row?.version === 2) return
    if (row !== undefined) throw new Error('Unexpected agent schema version')
    for (const table of tables) sql.run(`DROP TABLE IF EXISTS ${table}`)
    create()
    sql.run('INSERT INTO schema_versions (name,version) VALUES (?,2)', name)
  })
}

export function migrateAgentSchema(sql: Sql): void {
  transition(sql, 'agents', RETIRED_FLEET_TABLES, () => {})
}

export function migrateGrantSchema(sql: Sql): void {
  transition(sql, 'grants', ['sponsor_grants'], () => {
    sql.run(`CREATE TABLE grants (
      delegation_hash TEXT PRIMARY KEY, kind TEXT NOT NULL,
      delegator TEXT NOT NULL, delegate TEXT NOT NULL, owner TEXT NOT NULL,
      delegation_json TEXT NOT NULL, signature TEXT, status TEXT NOT NULL, expires_at INTEGER NOT NULL
    )`)
    sql.run('CREATE INDEX grants_delegator_kind ON grants(delegator,kind,expires_at)')
  })
}
