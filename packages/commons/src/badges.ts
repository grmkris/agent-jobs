import type { Address } from './schema/ids.ts'
import type { Badge } from './schema/messages.ts'
import type { Role } from './schema/roles.ts'
import type { ParticipantsSnapshot, StakePosition } from './services.ts'

export function participantBadges(address: Address, people: ParticipantsSnapshot | null): Badge[] {
  if (people === null) return []
  const badges: Badge[] = []
  if (people.creator === address) badges.push({ kind: 'owner' })
  if (people.approver === address) badges.push({ kind: 'approver' })
  if (people.worker === address) badges.push({ kind: 'worker' })
  if (people.bidders.includes(address)) badges.push({ kind: 'bidder' })
  if (people.arbitrator === address) badges.push({ kind: 'arbiter' })
  return badges
}
export function isParticipant(address: Address, people: ParticipantsSnapshot | null): boolean {
  return participantBadges(address, people).some((badge) => badge.kind !== 'arbiter')
}
export function snapshotBadges(
  address: Address,
  people: ParticipantsSnapshot | null,
  roles: readonly Role[],
  stake: StakePosition | null,
): Badge[] {
  const badges: Badge[] = [...participantBadges(address, people), ...roles.map((kind) => ({ kind }))]
  if (stake !== null) {
    if (stake.stake > 0n) badges.push({ kind: 'staker', amount: stake.stake.toString() })
    for (const p of stake.backing.positions)
      if (p.value > 0n) badges.push({ kind: 'backer', of: p.account, amount: p.value.toString() })
  }
  return [...new Map(badges.map((badge) => [`${badge.kind}:${badge.of ?? ''}`, badge])).values()]
}
