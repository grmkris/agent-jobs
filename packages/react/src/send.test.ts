import { describe, expect, it } from 'vitest'
import { monadTestnet } from 'viem/chains'
import { createBoardApi } from './client.ts'
import { SendError, createTxSender } from './send.ts'
import type { TxRequest } from './types.ts'

const tx = (i: number): TxRequest => ({
  description: `step ${i}`,
  chainId: 10143,
  to: `0x${'ab'.repeat(20)}`,
  data: `0x0${i}`,
  value: '0',
})

function harness(report: (n: number) => unknown) {
  let reports = 0
  const api = createBoardApi({
    baseUrl: '',
    storage: null,
    fetch: (async () => {
      reports++
      const r = report(reports)
      return new Response(
        JSON.stringify(r instanceof Error ? { ok: false, code: 'chain', message: r.message } : { ok: true, result: r }),
      )
    }) as typeof fetch,
  })
  const sends: unknown[] = []
  const provider = {
    request: async (a: { method: string; params?: unknown[] }) => {
      sends.push(a.params?.[0])
      return `0x${String(sends.length).padStart(64, '0')}`
    },
  }
  return { api, provider, sends, reported: () => reports }
}

describe('createTxSender', () => {
  it('sends in order, waits, reports each hash', async () => {
    const h = harness(() => ({}))
    const sender = createTxSender({
      api: h.api,
      provider: h.provider,
      from: '0x1',
      chain: monadTestnet,
      waitForReceipt: async () => ({ status: 'success' }),
    })
    const progress: string[] = []
    const hashes = await sender.send('t1', [tx(1), tx(2)], (p) => progress.push(`${p.index}:${p.reported}`))
    expect(hashes).toHaveLength(2)
    expect(h.sends).toEqual([
      { from: '0x1', to: tx(1).to, data: '0x01', value: '0x0' },
      { from: '0x1', to: tx(2).to, data: '0x02', value: '0x0' },
    ])
    expect(h.reported()).toBe(2)
    expect(progress).toEqual(['0:false', '1:false'])
  })

  it('a failed report keeps the sent hash and never resends', async () => {
    const h = harness((n) => (n === 1 ? new Error('board down') : {}))
    const sender = createTxSender({
      api: h.api,
      provider: h.provider,
      from: '0x1',
      chain: monadTestnet,
      waitForReceipt: async () => ({ status: 'success' }),
    })
    const err = await sender.send('t1', [tx(1), tx(2)]).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(SendError)
    expect((err as SendError).sent).toHaveLength(1)
    expect((err as SendError).sent[0]?.reported).toBe(false)
    expect(h.sends).toHaveLength(1)
  })

  it('batches when the host can, and a reverted batch sends nothing else', async () => {
    const h = harness(() => ({}))
    const sender = createTxSender({
      api: h.api,
      provider: h.provider,
      from: '0x1',
      chain: monadTestnet,
      sendBatch: async () => '0xbatch',
      waitForReceipt: async () => ({ status: 'reverted' }),
    })
    await expect(sender.send('t1', [tx(1), tx(2)])).rejects.toThrow(/batch reverted/)
    expect(h.sends).toHaveLength(0)
    expect(h.reported()).toBe(0)
  })
})
