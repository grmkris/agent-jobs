/**
 * Sign-in with Ethereum for tenant boards (ADR-0008): one session store shared by every board, so a wallet signed
 * in on one board is signed in on all of them, and the SIWE `domain` is the page the wallet is on (an allowed origin
 * of the board, or the API host), so wallets show no domain mismatch.
 *
 * Async over any SQL with `all` + atomic `batch` (D1 in the Worker, node:sqlite in tests). The verification of the
 * signature is a callback so this stays free of chain clients: the Worker passes `publicClient.verifyMessage`, which
 * accepts EOAs and ERC-1271 wallets alike (a JobPool signs in through its curator this way, ADR-0007).
 */
import { type Address, getAddress, isAddress } from 'viem'
import { createSiweMessage, parseSiweMessage } from 'viem/siwe'

export type SessionSqlValue = string | number | null
export interface SessionSql {
  all<T>(query: string, ...params: SessionSqlValue[]): Promise<T[]>
  batch(statements: ReadonlyArray<{ readonly query: string; readonly params: readonly SessionSqlValue[] }>): Promise<void>
}

export const SESSION_SCHEMA: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY,
    address TEXT NOT NULL,
    origin TEXT NOT NULL,
    board_id TEXT NOT NULL,
    expires_at INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS siwe_nonces (
    nonce TEXT PRIMARY KEY,
    address TEXT NOT NULL,
    domain TEXT NOT NULL,
    expires_at INTEGER NOT NULL,
    used INTEGER NOT NULL DEFAULT 0
  )`,
  `CREATE TABLE IF NOT EXISTS mcp_sessions (
    id TEXT PRIMARY KEY,
    session TEXT NOT NULL
  )`,
]

export const SESSION_SECONDS = 24 * 3600
export const NONCE_SECONDS = 10 * 60

export class SessionError extends Error {
  constructor(
    readonly code: 'invalid' | 'forbidden',
    message: string,
  ) {
    super(message)
  }
}

function randomId(bytes: number): string {
  return [...crypto.getRandomValues(new Uint8Array(bytes))].map((b) => b.toString(16).padStart(2, '0')).join('')
}

export interface SessionDeps {
  readonly sql: SessionSql
  readonly now?: () => number
  /** Whether `signature` over `message` is `address`'s (EOA or ERC-1271). */
  readonly verify: (input: { address: Address; message: string; signature: `0x${string}` }) => Promise<boolean>
}

export class SessionDesk {
  readonly #sql: SessionSql
  readonly #now: () => number
  readonly #verify: SessionDeps['verify']

  constructor(deps: SessionDeps) {
    this.#sql = deps.sql
    this.#now = deps.now ?? (() => Math.floor(Date.now() / 1000))
    this.#verify = deps.verify
  }

  /** Creates the tables if they are missing (idempotent). */
  async migrate(): Promise<void> {
    await this.#sql.batch(SESSION_SCHEMA.map((query) => ({ query, params: [] })))
  }

  /** A SIWE message for `address` to sign, bound to `domain` (the page's host) and this board; valid ten minutes, once. */
  async challenge(input: { address: string; domain: string; uri: string; chainId: number; boardId: string }): Promise<{ message: string }> {
    if (!isAddress(input.address)) throw new SessionError('invalid', 'address must be a 0x address')
    const address = getAddress(input.address)
    const nonce = randomId(12)
    const now = this.#now()
    await this.#sql.batch([{ query: 'INSERT INTO siwe_nonces (nonce, address, domain, expires_at, used) VALUES (?, ?, ?, ?, 0)', params: [nonce, address, input.domain, now + NONCE_SECONDS] }])
    const message = createSiweMessage({
      address,
      chainId: input.chainId,
      domain: input.domain,
      uri: input.uri,
      version: '1',
      nonce,
      issuedAt: new Date(now * 1000),
      expirationTime: new Date((now + NONCE_SECONDS) * 1000),
      statement: `Sign in to the sidequest board "${input.boardId}". This signature moves no funds.`,
    })
    return { message }
  }

  /**
   * Verifies a signed challenge and opens a 24 h session valid on every board. `domainAllowed` says whether the
   * message's domain may sign in on the board the request came to (the board's origins or the API host).
   */
  async login(input: {
    message: string
    signature: string
    boardId: string
    domainAllowed: (domain: string) => boolean
  }): Promise<{ session: string; address: Address; expiresAt: number }> {
    const fields = parseSiweMessage(input.message)
    const now = this.#now()
    if (fields.address === undefined || fields.nonce === undefined || fields.domain === undefined) throw new SessionError('invalid', 'not a SIWE message')
    const [nonce] = await this.#sql.all<{ address: string; domain: string; expires_at: number; used: number }>(
      'SELECT address, domain, expires_at, used FROM siwe_nonces WHERE nonce = ?',
      fields.nonce,
    )
    if (nonce === undefined || nonce.used !== 0 || nonce.expires_at < now || nonce.address.toLowerCase() !== fields.address.toLowerCase()) {
      throw new SessionError('forbidden', 'unknown, used or expired sign-in nonce; request a new auth_challenge')
    }
    if (fields.domain !== nonce.domain) throw new SessionError('forbidden', 'SIWE domain mismatch')
    if (!input.domainAllowed(fields.domain)) throw new SessionError('forbidden', `domain "${fields.domain}" may not sign in on board "${input.boardId}"`)
    if (!/^0x[0-9a-fA-F]+$/.test(input.signature)) throw new SessionError('invalid', 'signature must be 0x hex')
    const valid = await this.#verify({ address: fields.address, message: input.message, signature: input.signature as `0x${string}` })
    if (!valid) throw new SessionError('forbidden', 'signature does not match the address')
    const session = randomId(32)
    const expiresAt = now + SESSION_SECONDS
    const origin = fields.uri === undefined ? '' : (() => { try { return new URL(fields.uri).origin } catch { return '' } })()
    await this.#sql.batch([
      { query: 'UPDATE siwe_nonces SET used = 1 WHERE nonce = ?', params: [fields.nonce] },
      { query: 'INSERT INTO sessions (id, address, origin, board_id, expires_at) VALUES (?, ?, ?, ?, ?)', params: [session, getAddress(fields.address), origin, input.boardId, expiresAt] },
    ])
    return { session, address: getAddress(fields.address), expiresAt }
  }

  /** The wallet behind a live session token, if any. */
  async sessionAddress(session: string | undefined): Promise<{ address: Address; origin: string; boardId: string } | undefined> {
    if (session === undefined || session === '') return undefined
    const [row] = await this.#sql.all<{ address: string; origin: string; board_id: string; expires_at: number }>(
      'SELECT address, origin, board_id, expires_at FROM sessions WHERE id = ?',
      session,
    )
    if (row === undefined || row.expires_at < this.#now()) return undefined
    return { address: getAddress(row.address), origin: row.origin, boardId: row.board_id }
  }

  /** Binds an MCP session to a signed-in session, so an agent that signed in through a tool stays signed in. */
  async bindMcp(mcpSession: string, session: string): Promise<void> {
    await this.#sql.batch([{ query: 'INSERT INTO mcp_sessions (id, session) VALUES (?, ?) ON CONFLICT (id) DO UPDATE SET session = excluded.session', params: [mcpSession, session] }])
  }

  /** The caller behind a bearer token or, failing that, a bound MCP session. */
  async resolve(auth: { bearer?: string | undefined; mcpSession?: string | undefined }): Promise<{ address: Address; origin: string; boardId: string } | undefined> {
    const direct = await this.sessionAddress(auth.bearer)
    if (direct !== undefined) return direct
    if (auth.mcpSession === undefined) return undefined
    const [row] = await this.#sql.all<{ session: string }>('SELECT session FROM mcp_sessions WHERE id = ?', auth.mcpSession)
    return this.sessionAddress(row?.session)
  }
}
