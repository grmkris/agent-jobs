/** Pure G1b -> G1c migration. Historical sends and cap reservations remain intact. */
export function migrateCrewJournal(state, { kind, previousBinding, nextBinding, oldHolding, newHolding, at }) {
  if (state.binding === nextBinding) return state
  if (state.binding !== previousBinding || oldHolding === newHolding) {
    throw new Error('Migration refuses an unexpected deployment binding')
  }
  const values = { ...state.values }
  const archiveKey = `deployment/archive/${oldHolding}`
  if (Object.hasOwn(values, archiveKey)) throw new Error('Previous deployment is already archived')
  if (kind === 'workers') {
    const entries = {}
    for (const slug of ['canvas', 'studio']) {
      entries[slug] = values[`${slug}/entries`] ?? {}
      values[`${slug}/entries`] = {}
    }
    values[archiveKey] = { binding: state.binding, holding: oldHolding, entries }
  } else if (kind === 'demand') {
    const bot = values.bot
    if (!bot || bot.sequence !== 0 || bot.operations.length !== 0
      || Object.values(bot.spend.committed).some(amount => BigInt(amount) !== 0n)
      || Object.values(bot.spend.reserved).some(amount => BigInt(amount) !== 0n)
      || Object.keys(bot.spend.reservations).length !== 0) {
      throw new Error('Demand migration requires the held, unused creator journal')
    }
    values[archiveKey] = { binding: state.binding, holding: oldHolding }
  } else {
    throw new Error('Unknown crew journal kind')
  }
  values['deployment/holding'] = newHolding
  values['deployment/migrations'] = [...(values['deployment/migrations'] ?? []), {
    at, from: state.binding, to: nextBinding, oldHolding, newHolding,
  }]
  return { ...state, binding: nextBinding, values }
}
