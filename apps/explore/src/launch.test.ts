import { describe, expect, it, vi } from 'vitest'
import { LAUNCH_MESSAGE, READ_TOOLS, WRITE_METHODS, closeWrites, toolAllowed } from './launch.ts'

/** A tool list without D7's collect_actions, which Explore reads already and B4 adds to the board's list. */
const withoutCollect = (tools: Iterable<string>) => [...tools].filter((t) => t !== 'collect_actions').toSorted()

describe('the board client before launch', () => {
  it('lets every tool through while writes are open, and only reads while they are closed', () => {
    expect(toolAllowed('create_task', true)).toBe(true)
    for (const read of ['get_task', 'task_index', 'auth_challenge', 'auth_login', 'sponsor_status', 'collect_actions'])
      expect(toolAllowed(read, false)).toBe(true)
    for (const write of [
      'create_task',
      'publish_transactions',
      'select_worker',
      'submit_selection',
      'pick_quote',
      'request_quotes',
      'sponsor_prepare',
      'sponsor_submit',
      'telegram_link_prepare',
      'report_transaction',
      'create_board',
      'a_tool_added_later',
    ]) {
      expect(toolAllowed(write, false)).toBe(false)
    }
  })

  // Explore's list is the board's own read-only list (packages/board/src/admission.ts), plus D7's collect_actions,
  // which B4 adds there. Loaded by path so Explore's typecheck does not compile the board's sources.
  it('reads exactly what the board counts as read-only', async () => {
    const { readOnlyHostedTools } = (await import(
      /* @vite-ignore */ new URL('../../../packages/board/src/admission.ts', import.meta.url).href
    )) as { readOnlyHostedTools: Set<string> }
    expect(withoutCollect(READ_TOOLS)).toEqual(withoutCollect(readOnlyHostedTools))
  })
})

interface FakeProvider {
  request(args: { method: string; params?: unknown }): Promise<unknown>
  on(event: string, listener: () => void): unknown
  isPrivy: boolean
}
function provider(): FakeProvider & { request: ReturnType<typeof vi.fn> } {
  const request = vi.fn(async ({ method }: { method: string; params?: unknown }) => `${method} done`)
  return {
    request,
    on: vi.fn(function (this: unknown) {
      return this
    }),
    isPrivy: true,
  }
}

describe('the wallet before launch', () => {
  it('is the same provider while writes are open', () => {
    const p = provider()
    expect(closeWrites(p, true)).toBe(p)
    expect(closeWrites(undefined, false)).toBeUndefined()
  })

  it('refuses to send or sign while they are closed, and still reads and signs in', async () => {
    const p = provider()
    const closed = closeWrites(p, false)
    if (closed === undefined) throw new Error('expected a provider')
    for (const method of WRITE_METHODS) {
      await expect(closed.request({ method, params: [] })).rejects.toMatchObject({
        code: 4100,
        message: LAUNCH_MESSAGE,
      })
    }
    expect(p.request).not.toHaveBeenCalled()
    await expect(closed.request({ method: 'eth_call', params: [] })).resolves.toBe('eth_call done')
    await expect(closed.request({ method: 'personal_sign', params: [] })).resolves.toBe('personal_sign done')
    expect(closed.isPrivy).toBe(true)
    expect(closed.on('accountsChanged', () => {})).toBe(p)
  })
})
