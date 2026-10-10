import { Effect } from 'effect'
import { CommonsSql, RolesConfig } from '../services.ts'
import { ListRolesOutput, type ListRolesInput, type Role } from '../schema/roles.ts'
import { rolesOf } from './holders.ts'
import { logPage } from './log.ts'

export const listRoles = Effect.fnUntraced(function* (caller: string | undefined, input: typeof ListRolesInput.Type) {
  const config = yield* RolesConfig
  if (!config.enabled)
    return ListRolesOutput.make({ enabled: false, roles: [], log: [], cursor: null, hasMore: false, viewer: null })
  const roles = (['moderator', 'maintainer', 'arbiter'] satisfies Role[]).map((role) => ({
    role,
    holders: [...new Set(config[role].map((a) => a.toLowerCase()))],
    source: role === 'arbiter' ? 'deployment and configured arbitrators' : 'stage config',
  }))
  const sql = yield* CommonsSql
  const { log, hasMore } = logPage(sql, input.cursor, input.limit ?? 50)
  return ListRolesOutput.make({
    enabled: true,
    roles,
    log,
    cursor: log.at(-1) === undefined ? (input.cursor ?? null) : `c:${log.at(-1)!.seq}`,
    hasMore,
    viewer: caller === undefined ? null : { address: caller, roles: rolesOf(config, caller) },
  })
})
