import { Effect } from 'effect'
import { isParticipant } from '../badges.ts'
import { StakeRequired } from '../errors.ts'
import type { Address } from '../schema/ids.ts'
import type { Viewer } from '../schema/messages.ts'
import { authenticated, enabled, rolesOf } from '../roles/holders.ts'
import { POST_MINIMUM, readStake } from '../stake.ts'
import { RolesConfig, type ParticipantsSnapshot, type StakePosition } from '../services.ts'

export const postingAccess = Effect.fnUntraced(function* (
  caller: Address | undefined,
  people: ParticipantsSnapshot | null,
) {
  const config = yield* enabled()
  const address = yield* authenticated(caller)
  const roles = rolesOf(config, address)
  let stake: StakePosition | null = null
  if (roles.length === 0 && !isParticipant(address, people)) {
    stake = yield* readStake(address)
    if (stake.stake < POST_MINIMUM && stake.backing.total < POST_MINIMUM)
      return yield* new StakeRequired({
        minimum: POST_MINIMUM.toString(),
        stake: stake.stake.toString(),
        backing: stake.backing.total.toString(),
      })
  }
  if (stake === null) stake = yield* readStake(address).pipe(Effect.catch(() => Effect.succeed(null)))
  return { address, roles, stake, config }
})
export const threadViewer = Effect.fnUntraced(function* (
  caller: Address | undefined,
  people: ParticipantsSnapshot | null,
) {
  if (caller === undefined) return null
  const config = yield* RolesConfig
  const roles = rolesOf(config, caller)
  const bypass = roles.length > 0 || isParticipant(caller, people)
  const position = bypass ? null : yield* readStake(caller).pipe(Effect.catch(() => Effect.succeed(null)))
  const canPost =
    bypass || (position !== null && (position.stake >= POST_MINIMUM || position.backing.total >= POST_MINIMUM))
  const viewer: Viewer = {
    address: caller,
    roles,
    canPost,
    needs: canPost ? null : 'stake',
    minimum: POST_MINIMUM.toString(),
    stake: position?.stake.toString() ?? null,
    backing: position?.backing.total.toString() ?? null,
  }
  return viewer
})
