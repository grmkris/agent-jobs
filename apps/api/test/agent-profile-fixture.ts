import { DatabaseSync } from 'node:sqlite'
import { afterEach } from 'vitest'
import { AgentStore, fromNodeSqlite } from '@sidequest/board'
import * as sdk from '@sidequest/sdk'
import { AgentProfileUpdates } from '../src/agent-profiles.ts'

const databases: DatabaseSync[] = []
afterEach(() => {
  for (const db of databases.splice(0)) db.close()
})
export const origin = 'https://dev.sidequest.exchange'
export const operator = '0x1111111111111111111111111111111111111111' as const
export const outsider = '0x2222222222222222222222222222222222222222' as const
export const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1])

export function fixture() {
  const db = new DatabaseSync(':memory:')
  databases.push(db)
  const sql = fromNodeSqlite(db)
  const context = sdk.context('monad-testnet', 'main', 'http://127.0.0.1:9')
  const agents = new AgentStore(sql, () => 1_800_000_000)
  agents.create({
    id: 'one',
    operator,
    privyUserId: 'did:privy:one',
    name: 'Quill',
    registry: context.deployment.identity,
    chainId: context.deployment.chainId,
  })
  let now = 1_800_000_000
  const files = new Map<string, Uint8Array>()
  const bucket = {
    put: async (key: string, bytes: Uint8Array) => {
      files.set(key, bytes)
      return { key }
    },
    get: async (key: string) => {
      const bytes = files.get(key)
      return bytes === undefined ? null : { arrayBuffer: async () => new Uint8Array(bytes).buffer }
    },
  }
  let generations = 0
  let fail = false
  const model = {
    generate: async (_prompt: string) => {
      generations++
      if (fail) throw new Error('provider unavailable')
      return { bytes: png, type: 'image/jpeg' as const }
    },
  }
  const boot = () =>
    new AgentProfileUpdates({
      sql,
      now: () => now,
      origin,
      boardId: 'public',
      bucket,
      model,
      directory: () => undefined,
    })
  const bindings = { PUBLIC_ORIGIN: origin, Manifests: bucket, ImageModel: model }
  return {
    db,
    sql,
    context,
    agents,
    files,
    boot,
    bindings,
    now: () => now,
    generations: () => generations,
    advance: () => {
      now += 86400
    },
    fail: (value: boolean) => {
      fail = value
    },
  }
}
