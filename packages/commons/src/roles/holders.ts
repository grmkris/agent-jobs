import { Effect } from 'effect'
import { Disabled, Forbidden, Unauthenticated } from '../errors.ts'
import type { Address } from '../schema/ids.ts'
import type { Role } from '../schema/roles.ts'
import { RolesConfig } from '../services.ts'

export const enabled = Effect.fnUntraced(function* () {
  const config = yield* RolesConfig
  if (!config.enabled) return yield* new Disabled({ message: 'Commons is disabled in this stage' })
  return config
})
export function rolesOf(config: RolesConfig['Service'], caller: Address | undefined): Role[] {
  if (caller === undefined) return []
  return (['moderator', 'maintainer', 'arbiter'] satisfies Role[]).filter((role) =>
    config[role].some((address) => address.toLowerCase() === caller.toLowerCase()),
  )
}
export const authenticated = (caller: Address | undefined) =>
  caller === undefined
    ? Effect.fail(new Unauthenticated({ message: 'Sign in to write to Commons' }))
    : Effect.succeed(caller)
export const requireRole = Effect.fnUntraced(function* (caller: Address | undefined, maintainerOnly = false) {
  const config = yield* enabled()
  const address = yield* authenticated(caller)
  const roles = rolesOf(config, address)
  if (roles.includes('maintainer')) return { address, role: 'maintainer' satisfies Role }
  if (!maintainerOnly && roles.includes('moderator')) return { address, role: 'moderator' satisfies Role }
  return yield* new Forbidden({
    message: maintainerOnly ? 'Maintainer role required' : 'Moderator or Maintainer role required',
  })
})
