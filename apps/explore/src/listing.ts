/**
 * Operation keys for an operator's directory take-downs. A key is saved before the request and reused until the
 * action is known to have finished, so a retry after a lost reply or a reload is the same action, never a second one.
 */
type KeyStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>

const keyName = (agentId: string, serviceId: string | null) => `sidequest.listing-op:${agentId}:${serviceId ?? '*'}`

export function listingOperationKey(
  storage: KeyStorage,
  agentId: string,
  serviceId: string | null,
  fresh: () => string = () => crypto.randomUUID(),
): string {
  const name = keyName(agentId, serviceId)
  const saved = storage.getItem(name)
  if (saved !== null && /^[A-Za-z0-9_-]{1,128}$/.test(saved)) return saved
  const key = fresh()
  storage.setItem(name, key)
  if (storage.getItem(name) !== key) throw new Error('The take-down could not be saved, so it was not sent.')
  return key
}

export function finishListingOperation(storage: KeyStorage, agentId: string, serviceId: string | null): void {
  storage.removeItem(keyName(agentId, serviceId))
}
