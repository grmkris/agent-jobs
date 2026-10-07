import { describe, expect, it } from 'vitest'
import {
  InterruptedVaultPreparation,
  type VaultIntent,
  type VaultIntentCheckpoint,
  clearOwnedIntent,
  clearOwnedIntentDurable,
  discardVaultPreparation,
  readVaultIntentDurable,
  withVaultIntentLock,
  withVaultPermitPreparation,
  writeVaultIntent,
} from './vault-lock.ts'

const intent: VaultIntent = {
  id: 'first',
  kind: 'delegate',
  account: '0x1111111111111111111111111111111111111111',
  txs: [
    {
      description: 'delegate',
      chainId: 10143,
      to: '0x2222222222222222222222222222222222222222',
      data: '0xab',
      value: '0',
    },
  ],
}
function storageCache() {
  const values = new Map<string, string>()
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      values.set(key, value)
    },
    removeItem: (key: string) => {
      values.delete(key)
    },
  }
}
function checkpointStore(): VaultIntentCheckpoint {
  const values = new Map<string, string | null>()
  return {
    read: async (key) => values.get(key),
    write: async (key, value) => {
      values.set(key, value)
    },
  }
}

describe('vault intent lock', () => {
  it('serialises two tabs and rereads the shared pointer before preparing', async () => {
    let held = false
    const queue: Array<() => void> = []
    const locks = {
      request: async <T>(_name: string, work: () => Promise<T>): Promise<T> => {
        if (held) await new Promise<void>((resolve) => queue.push(resolve))
        held = true
        try {
          return await work()
        } finally {
          held = false
          queue.shift()?.()
        }
      },
    }
    const intents: string[] = []
    let pointer: { id: string } | null = null
    const prepare = (id: string) =>
      withVaultIntentLock(locks, 'vault:owner:agent', async () => {
        if (pointer !== null) throw new Error('saved intent already exists')
        await Promise.resolve()
        pointer = { id }
        intents.push(id)
      })
    await Promise.allSettled([prepare('first'), prepare('second')])
    expect(intents).toEqual(['first'])
  })

  it('clears only the intent the completing tab created', () => {
    const map = new Map<string, string>([['k', JSON.stringify({ id: 'new' })]])
    const storage = {
      getItem: (key: string) => map.get(key) ?? null,
      removeItem: (key: string) => map.delete(key),
    }
    expect(clearOwnedIntent(storage, 'k', 'old')).toBe(false)
    expect(map.has('k')).toBe(true)
    expect(clearOwnedIntent(storage, 'k', 'new')).toBe(true)
    expect(map.has('k')).toBe(false)
  })

  it('sees the committed intent with a stale null renderer cache, before it can sign', async () => {
    const checkpoint = checkpointStore()
    const firstTab = storageCache()
    const staleTab = storageCache()
    await writeVaultIntent(firstTab, 'k', intent, checkpoint)
    expect(staleTab.getItem('k')).toBeNull()
    expect(await readVaultIntentDurable(staleTab, 'k', checkpoint)).toEqual(intent)
    expect(staleTab.getItem('k')).toBeNull() // No reliance on a storage event or cache overwrite.
  })

  it('does not release the preparation lock before the checkpoint commit resolves', async () => {
    const firstTab = storageCache()
    let commit!: () => void
    let wrote!: () => void
    const writeStarted = new Promise<void>((resolve) => {
      wrote = resolve
    })
    const released: string[] = []
    const checkpoint: VaultIntentCheckpoint = {
      read: async () => undefined,
      write: async () => {
        wrote()
        await new Promise<void>((resolve) => {
          commit = resolve
        })
      },
    }
    const locks = {
      request: async <T>(_name: string, work: () => Promise<T>) => {
        const result = await work()
        released.push('released')
        return result
      },
    }
    const prepared = withVaultIntentLock(locks, 'k', () => writeVaultIntent(firstTab, 'k', intent, checkpoint))
    await writeStarted
    expect(firstTab.getItem('k')).toBeNull()
    expect(released).toEqual([])
    commit()
    await prepared
    expect(firstTab.getItem('k')).toBe(JSON.stringify(intent))
    expect(released).toEqual(['released'])
  })

  it('recovers the committed intent in another renderer when the local copy rejects', async () => {
    const checkpoint = checkpointStore()
    const firstTab = storageCache()
    const localFailure = new Error('local storage rejected')
    await expect(
      writeVaultIntent(
        {
          ...firstTab,
          setItem: () => {
            throw localFailure
          },
        },
        'k',
        intent,
        checkpoint,
      ),
    ).rejects.toBe(localFailure)
    expect(firstTab.getItem('k')).toBeNull()
    const secondTab = storageCache()
    expect(await readVaultIntentDurable(secondTab, 'k', checkpoint)).toEqual(intent)
    expect(await discardVaultPreparation(secondTab, 'k', intent.id, checkpoint)).toBe(false)
  })

  it('fails closed on a local intent without its checkpoint, and lets the owner discard it', async () => {
    const checkpoint = checkpointStore()
    const local = storageCache()
    local.setItem('k', JSON.stringify(intent))
    await expect(readVaultIntentDurable(local, 'k', checkpoint)).rejects.toThrow(/no durable record.*unknown/)
    expect(await checkpoint.read('k')).toBeUndefined()
    expect(await clearOwnedIntentDurable(local, 'k', intent.id, checkpoint)).toBe(true)
    expect(await readVaultIntentDurable(local, 'k', checkpoint)).toBeNull()
  })

  it('a committed clear cannot resurrect a stale legacy-looking pointer', async () => {
    const checkpoint = checkpointStore()
    const current = storageCache()
    const stale = storageCache()
    await writeVaultIntent(current, 'k', intent, checkpoint)
    stale.setItem('k', JSON.stringify(intent))
    expect(await clearOwnedIntentDurable(current, 'k', intent.id, checkpoint)).toBe(true)
    expect(await checkpoint.read('k')).toBeNull()
    await expect(readVaultIntentDurable(stale, 'k', checkpoint)).rejects.toThrow(/changed in another tab/)
    expect(await clearOwnedIntentDurable(current, 'k', intent.id, checkpoint)).toBe(true)
    expect(await readVaultIntentDurable(current, 'k', checkpoint)).toBeNull()
  })

  it('compare-delete preserves a newer intent in either store', async () => {
    const checkpoint = checkpointStore()
    const current = storageCache()
    await writeVaultIntent(current, 'k', { ...intent, id: 'newer' }, checkpoint)
    expect(await clearOwnedIntentDurable(current, 'k', intent.id, checkpoint)).toBe(false)
    expect((await readVaultIntentDurable(current, 'k', checkpoint))?.id).toBe('newer')
    await writeVaultIntent(current, 'k', intent, checkpoint)
    current.setItem('k', JSON.stringify({ ...intent, id: 'out-of-band-newer' }))
    expect(await clearOwnedIntentDurable(current, 'k', intent.id, checkpoint)).toBe(false)
    expect(JSON.parse(current.getItem('k')!).id).toBe('out-of-band-newer')
    await expect(readVaultIntentDurable(current, 'k', checkpoint)).rejects.toThrow(/changed in another tab/)
  })

  it('refuses checkpoint failures instead of allowing a new preparation or send', async () => {
    const unavailable = new Error('checkpoint unavailable')
    const checkpoint: VaultIntentCheckpoint = {
      read: async () => {
        throw unavailable
      },
      write: async () => {
        throw unavailable
      },
    }
    const current = storageCache()
    await expect(readVaultIntentDurable(current, 'k', checkpoint)).rejects.toBe(unavailable)
    await expect(writeVaultIntent(current, 'k', intent, checkpoint)).rejects.toBe(unavailable)
    expect(current.getItem('k')).toBeNull() // Never expose a pointer without its durable checkpoint.
    current.setItem('k', JSON.stringify(intent))
    await expect(clearOwnedIntentDurable(current, 'k', intent.id, checkpoint)).rejects.toBe(unavailable)
    expect(current.getItem('k')).toBe(JSON.stringify(intent))
  })

  it('two renderer caches expose no pointer or permit when reservation writes reject', async () => {
    const checkpoint: VaultIntentCheckpoint = {
      read: async () => undefined,
      write: async () => {
        throw new Error('checkpoint write rejected')
      },
    }
    const tabs = [storageCache(), storageCache()]
    const signatures = [0, 0]
    for (const [index, tab] of tabs.entries()) {
      expect(await readVaultIntentDurable(tab, 'k', checkpoint)).toBeNull()
      await expect(
        withVaultPermitPreparation(
          'k',
          async () => {
            signatures[index] = signatures[index]! + 1
            return 'permit'
          },
          async () => writeVaultIntent(tab, 'k', intent, checkpoint),
          checkpoint,
        ),
      ).rejects.toThrow('checkpoint write rejected')
      expect(tab.getItem('k')).toBeNull()
    }
    expect(signatures).toEqual([0, 0])
    await expect(writeVaultIntent(tabs[0]!, 'k', intent, checkpoint)).rejects.toThrow('checkpoint write rejected')
    expect(tabs[0]!.getItem('k')).toBeNull()
  })

  it('a failed final write leaves a durable reservation that stops the stale second renderer before signing', async () => {
    const committed = checkpointStore()
    const checkpoint: VaultIntentCheckpoint = {
      read: committed.read,
      write: async (key, value) => {
        if (value !== null && Array.isArray((JSON.parse(value) as VaultIntent).txs))
          throw new Error('final write rejected')
        await committed.write(key, value)
      },
    }
    const firstTab = storageCache()
    const staleTab = storageCache()
    let firstSignatures = 0
    let secondSignatures = 0
    await expect(
      withVaultPermitPreparation(
        'k',
        async () => {
          firstSignatures++
          return 'permit'
        },
        async () => writeVaultIntent(firstTab, 'k', intent, checkpoint),
        checkpoint,
      ),
    ).rejects.toBeInstanceOf(InterruptedVaultPreparation)
    expect(firstTab.getItem('k')).toBeNull()
    expect(staleTab.getItem('k')).toBeNull()
    await expect(
      (async () => {
        if ((await readVaultIntentDurable(staleTab, 'k', checkpoint)) !== null) return
        await withVaultPermitPreparation(
          'k',
          async () => {
            secondSignatures++
            return 'permit'
          },
          async () => writeVaultIntent(staleTab, 'k', intent, checkpoint),
          checkpoint,
        )
      })(),
    ).rejects.toBeInstanceOf(InterruptedVaultPreparation)
    expect(firstSignatures).toBe(1)
    expect(secondSignatures).toBe(0)
    const reservation = JSON.parse((await committed.read('k'))!) as { id: string }
    expect(await discardVaultPreparation(staleTab, 'k', 'wrong-id', committed)).toBe(false)
    expect(await discardVaultPreparation(staleTab, 'k', reservation.id, committed)).toBe(true)
    expect(await readVaultIntentDurable(staleTab, 'k', committed)).toBeNull()
  })

  it('discard cannot clear a prepared action or a local recovery pointer', async () => {
    const checkpoint = checkpointStore()
    const tab = storageCache()
    await writeVaultIntent(tab, 'k', intent, checkpoint)
    expect(await discardVaultPreparation(tab, 'k', intent.id, checkpoint)).toBe(false)
    await checkpoint.write('k', JSON.stringify({ preparing: true, id: 'reservation' }))
    expect(await discardVaultPreparation(tab, 'k', 'reservation', checkpoint)).toBe(false)
    expect(tab.getItem('k')).toBe(JSON.stringify(intent))
  })

  it('releases a refused permit prompt but retains the reservation if that clear fails', async () => {
    const checkpoint = checkpointStore()
    const refusal = new Error('permit refused')
    await expect(
      withVaultPermitPreparation(
        'k',
        async () => {
          throw refusal
        },
        async () => {},
        checkpoint,
      ),
    ).rejects.toBe(refusal)
    expect(await checkpoint.read('k')).toBeNull()
    const failingClear: VaultIntentCheckpoint = {
      read: checkpoint.read,
      write: async (key, value) => {
        if (value === null) throw new Error('clear rejected')
        await checkpoint.write(key, value)
      },
    }
    await expect(
      withVaultPermitPreparation(
        'k',
        async () => {
          throw refusal
        },
        async () => {},
        failingClear,
      ),
    ).rejects.toBeInstanceOf(InterruptedVaultPreparation)
    await expect(readVaultIntentDurable(storageCache(), 'k', checkpoint)).rejects.toBeInstanceOf(
      InterruptedVaultPreparation,
    )
  })
})
