import { describe, expect, it } from 'vitest'
import { finishListingOperation, listingOperationKey } from './listing.ts'

const store = () => {
  const values = new Map<string, string>()
  return {
    values,
    storage: {
      getItem: (k: string) => values.get(k) ?? null,
      setItem: (k: string, v: string) => {
        values.set(k, v)
      },
      removeItem: (k: string) => {
        values.delete(k)
      },
    },
  }
}

describe('listing take-down keys', () => {
  it('reuses one key per agent and target until the action finishes', () => {
    const { storage } = store()
    let n = 0
    const fresh = () => `key-${++n}`
    expect(listingOperationKey(storage, '7', 'translate', fresh)).toBe('key-1')
    expect(listingOperationKey(storage, '7', 'translate', fresh)).toBe('key-1')
    expect(listingOperationKey(storage, '7', null, fresh)).toBe('key-2')
    finishListingOperation(storage, '7', 'translate')
    expect(listingOperationKey(storage, '7', 'translate', fresh)).toBe('key-3')
  })
  it('refuses to send when the key cannot be saved', () => {
    const { storage } = store()
    expect(() => listingOperationKey({ ...storage, setItem: () => {} }, '7', null, () => 'k')).toThrow(
      /could not be saved/,
    )
  })
})
