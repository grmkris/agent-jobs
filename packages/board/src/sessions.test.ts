import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it } from 'vitest'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'
import { verifyMessage } from 'viem'
import { SessionDesk, type SessionSql } from './sessions.ts'

function sqlOf(db: DatabaseSync): SessionSql {
  return {
    all: async <T>(query: string, ...params: Array<string | number | null>) => db.prepare(query).all(...params) as T[],
    batch: async (statements) => {
      db.exec('BEGIN')
      try {
        for (const s of statements) db.prepare(s.query).run(...s.params)
        db.exec('COMMIT')
      } catch (e) {
        db.exec('ROLLBACK')
        throw e
      }
    },
  }
}

describe('SessionDesk', () => {
  const account = privateKeyToAccount(generatePrivateKey())
  let now = 1_700_000_000
  const desk = new SessionDesk({
    sql: sqlOf(new DatabaseSync(':memory:')),
    now: () => now,
    verify: ({ address, message, signature }) => verifyMessage({ address, message, signature }),
  })

  it('challenge → login → resolve, valid on another board, bound to the page domain', async () => {
    await desk.migrate()
    const { message } = await desk.challenge({
      address: account.address,
      domain: 'pet.example',
      uri: 'https://pet.example',
      chainId: 10143,
      boardId: 'monad-pet',
    })
    expect(message).toContain('pet.example wants you to sign in')
    expect(message).toContain('board "monad-pet"')
    const signature = await account.signMessage({ message })
    const r = await desk.login({ message, signature, boardId: 'monad-pet', domainAllowed: (d) => d === 'pet.example' })
    expect(r.address).toBe(account.address)
    expect((await desk.resolve({ bearer: r.session }))?.address).toBe(account.address)
    // The same token works on the public board: one session store for every board.
    expect((await desk.resolve({ bearer: r.session }))?.boardId).toBe('monad-pet')
    // A second login with the same nonce is refused.
    await expect(desk.login({ message, signature, boardId: 'monad-pet', domainAllowed: () => true })).rejects.toThrow(
      /used or expired/,
    )
    // Expiry.
    now += 25 * 3600
    expect(await desk.resolve({ bearer: r.session })).toBeUndefined()
  })

  it('refuses a domain the board does not allow and a wrong signature', async () => {
    const { message } = await desk.challenge({
      address: account.address,
      domain: 'evil.example',
      uri: 'https://evil.example',
      chainId: 10143,
      boardId: 'monad-pet',
    })
    const signature = await account.signMessage({ message })
    await expect(
      desk.login({ message, signature, boardId: 'monad-pet', domainAllowed: (d) => d === 'pet.example' }),
    ).rejects.toThrow(/may not sign in/)
    const { message: m2 } = await desk.challenge({
      address: account.address,
      domain: 'pet.example',
      uri: 'https://pet.example',
      chainId: 10143,
      boardId: 'monad-pet',
    })
    const other = privateKeyToAccount(generatePrivateKey())
    await expect(
      desk.login({
        message: m2,
        signature: await other.signMessage({ message: m2 }),
        boardId: 'monad-pet',
        domainAllowed: () => true,
      }),
    ).rejects.toThrow(/does not match/)
  })

  it('binds an MCP session', async () => {
    const { message } = await desk.challenge({
      address: account.address,
      domain: 'api.example',
      uri: 'https://api.example',
      chainId: 10143,
      boardId: 'public',
    })
    const r = await desk.login({
      message,
      signature: await account.signMessage({ message }),
      boardId: 'public',
      domainAllowed: () => true,
    })
    await desk.bindMcp('mcp-1', r.session)
    expect((await desk.resolve({ mcpSession: 'mcp-1' }))?.address).toBe(account.address)
    expect(await desk.resolve({ mcpSession: 'mcp-2' })).toBeUndefined()
  })
})
