/**
 * Automates the dependency table in docs/reality-check.md (spike S-1). For each dependency it makes the cheapest
 * real, read-only call that proves the credential tier, and the operation tier where a read-only call proves it,
 * then prints one row per dependency. Run from the repo root (Bun loads `.env.local` itself):
 *
 *   bun scripts/reality-check.ts
 *
 * It reads only the variables named in `.env.example`. An unset variable gives a "missing" row, never a crash.
 * It never prints a secret (every set value that is not an address or a public name is redacted from all output),
 * sends no transaction (the RPC helper allows only read methods) and makes no write call. It always exits 0.
 * No dependencies: keccak-256 and secp256k1 are implemented below so keys can be checked against addresses.
 */
import { createSign } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const root = join(import.meta.dirname, '..')

// --- Environment: only names from .env.example ------------------------------------------------------------------

const allowed = new Set(
  readFileSync(join(root, '.env.example'), 'utf8')
    .split('\n')
    .map((line) => /^([A-Z][A-Z0-9_]*)=/.exec(line)?.[1])
    .filter((name): name is string => name !== undefined),
)

function env(name: string): string | undefined {
  if (!allowed.has(name)) throw new Error(`${name} is not in .env.example`)
  const value = process.env[name]?.trim()
  return value === undefined || value === '' ? undefined : value
}

/** Values that may appear in output: addresses and names that identify rather than authenticate. */
const PUBLIC = new Set([
  'GITHUB_APP_ID',
  'GITHUB_APP_CLIENT_ID',
  'GITHUB_APP_INSTALLATION_ID',
  'FIXTURE_REPO',
  'CRE_WORKFLOW_NAME',
  'SCREENING_MODEL',
  'ARBITER_MODEL',
  'PRIVY_APP_ID',
  'PRIVY_SERVER_WALLET_ID',
  'CLOUDFLARE_ACCOUNT_ID',
])
const ADDRESS = /^0x[0-9a-fA-F]{40}$/

const secrets: string[] = []
for (const name of allowed) {
  const value = process.env[name]?.trim()
  if (value === undefined || value.length < 4 || PUBLIC.has(name) || ADDRESS.test(value)) continue
  secrets.push(value, value.replace(/\\n/g, '\n'), value.replace(/^0x/i, ''))
  // A PEM could be echoed line by line.
  for (const line of value.replace(/\\n/g, '\n').split('\n')) if (line.length >= 16) secrets.push(line.trim())
}
secrets.sort((a, b) => b.length - a.length)

function redact(text: string): string {
  let out = text
  for (const s of secrets) if (s.length >= 4) out = out.split(s).join('[redacted]')
  return out
}

// --- Keccak-256 and secp256k1 (enough to derive an address from a private key) -----------------------------------

const MASK = (1n << 64n) - 1n
const rotl = (x: bigint, n: number) => ((x << BigInt(n)) | (x >> BigInt(64 - n))) & MASK

const ROUND_CONSTANTS: bigint[] = (() => {
  const rc: bigint[] = []
  let r = 1
  for (let round = 0; round < 24; round++) {
    let c = 0n
    for (let j = 0; j < 7; j++) {
      r = ((r << 1) ^ ((r >> 7) * 0x71)) & 0xff
      if (r & 2) c ^= 1n << BigInt((1 << j) - 1)
    }
    rc.push(c)
  }
  return rc
})()

function keccakF(s: bigint[]): void {
  for (let round = 0; round < 24; round++) {
    const c = [0, 1, 2, 3, 4].map((x) => s[x]! ^ s[x + 5]! ^ s[x + 10]! ^ s[x + 15]! ^ s[x + 20]!)
    for (let i = 0; i < 25; i++) s[i] = s[i]! ^ c[(i + 4) % 5]! ^ rotl(c[(i + 1) % 5]!, 1)
    let x = 1
    let y = 0
    let current = s[1]!
    for (let t = 0; t < 24; t++) {
      ;[x, y] = [y, (2 * x + 3 * y) % 5]
      const next = s[x + 5 * y]!
      s[x + 5 * y] = rotl(current, ((t + 1) * (t + 2)) / 2 % 64)
      current = next
    }
    for (let row = 0; row < 25; row += 5) {
      const r = s.slice(row, row + 5)
      for (let i = 0; i < 5; i++) s[row + i] = r[i]! ^ (~r[(i + 1) % 5]! & MASK & r[(i + 2) % 5]!)
    }
    s[0] = s[0]! ^ ROUND_CONSTANTS[round]!
  }
}

function keccak256(data: Uint8Array): Uint8Array {
  const rate = 136
  const padded = new Uint8Array(Math.ceil((data.length + 1) / rate) * rate)
  padded.set(data)
  padded[data.length]! ^= 0x01
  padded[padded.length - 1]! ^= 0x80
  const s: bigint[] = Array.from({ length: 25 }, () => 0n)
  for (let off = 0; off < padded.length; off += rate) {
    for (let i = 0; i < rate / 8; i++) {
      let lane = 0n
      for (let b = 7; b >= 0; b--) lane = (lane << 8n) | BigInt(padded[off + i * 8 + b]!)
      s[i] = s[i]! ^ lane
    }
    keccakF(s)
  }
  const out = new Uint8Array(32)
  for (let i = 0; i < 32; i++) out[i] = Number((s[i >> 3]! >> BigInt(8 * (i & 7))) & 0xffn)
  return out
}

const P = 2n ** 256n - 2n ** 32n - 977n
const N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n
const G: Point = [
  0x79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798n,
  0x483ada7726a3c4655da4fbfc0e1108a8fd17b448a68554199c47d08ffb10d4b8n,
]
type Point = [bigint, bigint] | null

const mod = (a: bigint) => ((a % P) + P) % P
function inv(a: bigint): bigint {
  let [r0, r1, s0, s1] = [mod(a), P, 1n, 0n]
  while (r1 !== 0n) {
    const q = r0 / r1
    ;[r0, r1, s0, s1] = [r1, r0 - q * r1, s1, s0 - q * s1]
  }
  return mod(s0)
}
function add(a: Point, b: Point): Point {
  if (a === null) return b
  if (b === null) return a
  if (a[0] === b[0] && mod(a[1] + b[1]) === 0n) return null
  const l = a[0] === b[0] ? mod(3n * a[0] * a[0] * inv(2n * a[1])) : mod((b[1] - a[1]) * inv(b[0] - a[0]))
  const x = mod(l * l - a[0] - b[0])
  return [x, mod(l * (a[0] - x) - a[1])]
}

/** The lower-case address of a 32-byte hex private key, or undefined if it is not a valid key. */
function addressOf(privateKey: string): string | undefined {
  const hex = privateKey.replace(/^0x/i, '')
  if (!/^[0-9a-fA-F]{64}$/.test(hex)) return undefined
  let k = BigInt(`0x${hex}`)
  if (k === 0n || k >= N) return undefined
  let result: Point = null
  let base: Point = G
  while (k > 0n) {
    if (k & 1n) result = add(result, base)
    base = add(base, base)
    k >>= 1n
  }
  if (result === null) return undefined
  const pub = new Uint8Array(64)
  for (const [i, v] of result.entries()) {
    const h = v.toString(16).padStart(64, '0')
    for (let j = 0; j < 32; j++) pub[i * 32 + j] = Number.parseInt(h.slice(j * 2, j * 2 + 2), 16)
  }
  return `0x${Buffer.from(keccak256(pub).slice(12)).toString('hex')}`
}

// --- Read-only helpers --------------------------------------------------------------------------------------------

const READ_METHODS = new Set(['eth_chainId', 'eth_blockNumber', 'eth_getBalance', 'eth_getTransactionCount', 'eth_getCode', 'eth_call'])

async function rpc(url: string, method: string, params: unknown[] = []): Promise<string> {
  if (!READ_METHODS.has(method)) throw new Error(`${method} is not a read method`)
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    signal: AbortSignal.timeout(15_000),
  })
  const body = (await res.json().catch(() => ({}))) as { result?: string; error?: { message?: string } }
  if (typeof body.result !== 'string') throw new Error(`${method}: HTTP ${res.status} ${body.error?.message ?? ''}`.trim())
  return body.result
}

async function http(url: string, init: RequestInit = {}): Promise<{ status: number; ok: boolean; json: any }> {
  const res = await fetch(url, { signal: AbortSignal.timeout(30_000), ...init })
  return { status: res.status, ok: res.ok, json: await res.json().catch(() => undefined) }
}

const mon = (wei: string) => `${(Number(BigInt(wei)) / 1e18).toFixed(3)} MON`
const short = (address: string) => `${address.slice(0, 6)}…${address.slice(-4)}`

function config(network: 'monad-testnet' | 'monad-mainnet'): any {
  try {
    return JSON.parse(readFileSync(join(root, 'contracts/config', `${network}.json`), 'utf8'))
  } catch {
    return undefined
  }
}
const testnet = config('monad-testnet')
const mainnet = config('monad-mainnet')

// --- Rows ---------------------------------------------------------------------------------------------------------

type Tier = 'missing' | 'failed' | 'unproven' | 'credential' | 'operation'
interface Row {
  name: string
  tier: Tier
  evidence: string
  next: string
}
type Probe = () => Promise<Omit<Row, 'name'>>

function missing(names: string[]): Omit<Row, 'name'> | undefined {
  const unset = names.filter((n) => env(n) === undefined)
  return unset.length === 0 ? undefined : { tier: 'missing', evidence: '—', next: `set ${unset.join(', ')}` }
}

async function monadRpc(urlVar: string, chainId: number, next: string): Promise<Omit<Row, 'name'>> {
  const m = missing([urlVar])
  if (m) return m
  const url = env(urlVar)!
  const id = Number(await rpc(url, 'eth_chainId'))
  if (id !== chainId) return { tier: 'failed', evidence: `eth_chainId = ${id}`, next: `an RPC for chain ${chainId}` }
  const block = Number(await rpc(url, 'eth_blockNumber'))
  const admin: string | undefined = (chainId === 10143 ? testnet : mainnet)?.roles?.admin
  if (admin === undefined) return { tier: 'credential', evidence: `chain id ${id}, block ${block}`, next: 'contracts/config to read a balance' }
  const balance = await rpc(url, 'eth_getBalance', [admin, 'latest'])
  return { tier: 'operation', evidence: `chain id ${id}, block ${block}; balance of admin ${short(admin)} = ${mon(balance)}`, next }
}

async function registries(): Promise<Omit<Row, 'name'>> {
  const m = missing(['MONAD_TESTNET_RPC_URL'])
  if (m) return m
  const url = env('MONAD_TESTNET_RPC_URL')!
  const parts: string[] = []
  for (const [label, address] of Object.entries<string>(testnet?.erc8004 ?? {})) {
    const code = await rpc(url, 'eth_getCode', [address, 'latest'])
    if (code === '0x') return { tier: 'failed', evidence: `no code at ${label} ${short(address)} (10143)`, next: 'the registry deployed at the configured address' }
    parts.push(`${label} ${short(address)} has code`)
  }
  if (parts.length === 0) return { tier: 'failed', evidence: 'no erc8004 addresses in contracts/config/monad-testnet.json', next: 'the config' }
  let usdc = 'USDC (143) not read: MONAD_MAINNET_RPC_URL unset'
  const mainnetUrl = env('MONAD_MAINNET_RPC_URL')
  const token: string | undefined = mainnet?.allowedTokens?.[0]
  if (mainnetUrl !== undefined && token !== undefined) {
    const decimals = Number(await rpc(mainnetUrl, 'eth_call', [{ to: token, data: '0x313ce567' }, 'latest']))
    usdc = `USDC ${short(token)} (143) decimals() = ${decimals}`
  }
  return { tier: 'operation', evidence: `${parts.join(', ')} (10143); ${usdc}`, next: 'used by the fork tests (end-to-end)' }
}

/** A key-holding EOA: credential when the key derives to the stated address, operation when that address has sent. */
async function eoa(keyVar: string, addressVar: string, role: string | undefined): Promise<Omit<Row, 'name'>> {
  const m = missing([keyVar, addressVar, 'MONAD_TESTNET_RPC_URL'])
  if (m) return m
  const stated = env(addressVar)!
  const derived = addressOf(env(keyVar)!)
  if (derived === undefined) return { tier: 'failed', evidence: `${keyVar} is not a valid secp256k1 key`, next: 'a valid key' }
  if (derived !== stated.toLowerCase()) return { tier: 'failed', evidence: `${keyVar} does not derive to ${addressVar} ${short(stated)}`, next: 'the matching key or address' }
  const configured: string | undefined = role === undefined ? undefined : testnet?.roles?.[role]
  const roleNote =
    configured === undefined ? '' : configured.toLowerCase() === derived ? `; matches config role ${role}` : `; differs from config role ${role} ${short(configured)}`
  const url = env('MONAD_TESTNET_RPC_URL')!
  const [balance, nonce] = await Promise.all([rpc(url, 'eth_getBalance', [stated, 'latest']), rpc(url, 'eth_getTransactionCount', [stated, 'latest'])])
  const evidence = `key derives to ${short(stated)}${roleNote}; ${mon(balance)}, nonce ${Number(nonce)} (10143)`
  return Number(nonce) > 0
    ? { tier: 'operation', evidence: `${evidence}: it has sent transactions`, next: 'end-to-end: its product flow (not provable read-only)' }
    : { tier: 'credential', evidence, next: 'a first transaction (this script sends none)' }
}

async function monadscan(): Promise<Omit<Row, 'name'>> {
  const m = missing(['MONADSCAN_API_KEY'])
  if (m) return m
  const address: string = testnet?.roles?.admin ?? '0x0000000000000000000000000000000000000000'
  const q = new URLSearchParams({ chainid: '10143', module: 'account', action: 'balance', address, tag: 'latest', apikey: env('MONADSCAN_API_KEY')! })
  const { json } = await http(`https://api.etherscan.io/v2/api?${q}`)
  if (json?.status !== '1') return { tier: 'failed', evidence: `balance query: ${String(json?.message ?? 'no response')} ${String(json?.result ?? '')}`.trim(), next: 'a valid API key' }
  return { tier: 'credential', evidence: `v2 balance query chainid=10143 for ${short(address)} = ${mon(json.result)}`, next: 'verify a contract (a write; not done here)' }
}

async function cloudflare(): Promise<Omit<Row, 'name'>> {
  const m = missing(['CLOUDFLARE_API_TOKEN', 'CLOUDFLARE_ACCOUNT_ID'])
  if (m) return m
  const account = env('CLOUDFLARE_ACCOUNT_ID')!
  const headers = { authorization: `Bearer ${env('CLOUDFLARE_API_TOKEN')!}` }
  const api = 'https://api.cloudflare.com/client/v4'
  let verify = await http(`${api}/user/tokens/verify`, { headers })
  if (!verify.json?.success) verify = await http(`${api}/accounts/${account}/tokens/verify`, { headers })
  if (!verify.json?.success) return { tier: 'failed', evidence: `token verify: HTTP ${verify.status}`, next: 'a valid API token' }
  const scripts = await http(`${api}/accounts/${account}/workers/scripts`, { headers })
  const stores = await http(`${api}/accounts/${account}/secrets_store/stores`, { headers })
  const storeNote = stores.json?.success ? 'Secrets Store readable' : `Secrets Store not readable (HTTP ${stores.status})`
  if (!scripts.json?.success)
    return { tier: 'credential', evidence: `token ${verify.json.result?.status ?? 'verified'}; Workers list HTTP ${scripts.status}; ${storeNote}`, next: 'Workers read permission' }
  return {
    tier: 'operation',
    evidence: `token ${verify.json.result?.status ?? 'verified'}; ${scripts.json.result.length} Worker script(s) listed; ${storeNote}`,
    next: stores.json?.success ? 'end-to-end: a deploy (not done here)' : 'Secrets Store: Edit on the token (remote alchemy state)',
  }
}

async function hypersync(): Promise<Omit<Row, 'name'>> {
  const m = missing(['HYPERSYNC_API_TOKEN'])
  if (m) return m
  const base = 'https://monad-testnet.hypersync.xyz'
  const headers = { authorization: `Bearer ${env('HYPERSYNC_API_TOKEN')!}`, 'content-type': 'application/json' }
  const height = await http(`${base}/height`, { headers })
  if (typeof height.json?.height !== 'number') return { tier: 'failed', evidence: `GET /height: HTTP ${height.status}`, next: 'a reachable HyperSync endpoint' }
  // /height answers without a token; a one-block query (a read) is what checks it.
  const to = height.json.height as number
  const query = await http(`${base}/query`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ from_block: to - 1, to_block: to, logs: [{ address: [testnet?.deployment?.core ?? '0x0000000000000000000000000000000000000000'] }], field_selection: { log: ['block_number'] } }),
  })
  if (!query.ok) return { tier: 'failed', evidence: `GET /height = ${to}; one-block query: HTTP ${query.status} ${String(query.json?.error ?? '')}`.trim(), next: 'a valid API token' }
  return { tier: 'credential', evidence: `GET /height = ${to}; one-block log query accepted the token`, next: 'a log query with decoding and pagination (S4)' }
}

function b64url(data: string | Buffer): string {
  return Buffer.from(data).toString('base64url')
}

async function githubApp(): Promise<Omit<Row, 'name'>> {
  const m = missing(['GITHUB_APP_ID', 'GITHUB_APP_PRIVATE_KEY', 'GITHUB_APP_INSTALLATION_ID'])
  if (m) return m
  const now = Math.floor(Date.now() / 1000)
  const unsigned = `${b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }))}.${b64url(JSON.stringify({ iat: now - 60, exp: now + 540, iss: env('GITHUB_APP_ID')! }))}`
  const signature = createSign('RSA-SHA256').update(unsigned).sign(env('GITHUB_APP_PRIVATE_KEY')!.replace(/\\n/g, '\n'))
  const headers = { accept: 'application/vnd.github+json', 'user-agent': 'agent-jobs-reality-check', 'x-github-api-version': '2022-11-28' }
  const app = await http('https://api.github.com/app', { headers: { ...headers, authorization: `Bearer ${unsigned}.${b64url(signature)}` } })
  if (!app.ok) return { tier: 'failed', evidence: `JWT → GET /app: HTTP ${app.status}`, next: 'a valid app id and private key' }
  // Minting a short-lived installation token is the read path the attester uses; it changes no state.
  const installation = env('GITHUB_APP_INSTALLATION_ID')!
  const tokenRes = await http(`https://api.github.com/app/installations/${installation}/access_tokens`, {
    method: 'POST',
    headers: { ...headers, authorization: `Bearer ${unsigned}.${b64url(signature)}` },
  })
  const token: unknown = tokenRes.json?.token
  if (typeof token !== 'string') return { tier: 'credential', evidence: `JWT → app "${app.json?.slug}"; installation ${installation} token: HTTP ${tokenRes.status}`, next: 'the app installed (installation id)' }
  secrets.push(token)
  const evidence = `JWT → app "${app.json?.slug}" → installation ${installation} token`
  const repo = env('FIXTURE_REPO')
  if (repo === undefined) return { tier: 'credential', evidence, next: 'set FIXTURE_REPO to read check runs' }
  const runs = await http(`https://api.github.com/repos/${repo}/commits/HEAD/check-runs?per_page=100`, { headers: { ...headers, authorization: `Bearer ${token}` } })
  if (!runs.ok) return { tier: 'credential', evidence: `${evidence}; check-runs of ${repo}@HEAD: HTTP ${runs.status}`, next: 'read access to FIXTURE_REPO' }
  return { tier: 'operation', evidence: `${evidence} → check-runs of ${repo}@HEAD (${runs.json?.total_count ?? 0} runs)`, next: 'end-to-end: the attester in the board / CRE (S5)' }
}

async function privy(): Promise<Omit<Row, 'name'>> {
  const m = missing(['PRIVY_APP_ID', 'PRIVY_APP_SECRET', 'PRIVY_SERVER_WALLET_ID'])
  if (m) return m
  const appId = env('PRIVY_APP_ID')!
  const { status, json } = await http(`https://api.privy.io/v1/wallets/${env('PRIVY_SERVER_WALLET_ID')!}`, {
    headers: { authorization: `Basic ${btoa(`${appId}:${env('PRIVY_APP_SECRET')!}`)}`, 'privy-app-id': appId },
  })
  const address: unknown = json?.address
  if (typeof address !== 'string') return { tier: 'failed', evidence: `wallet lookup: HTTP ${status}`, next: 'a valid app secret and wallet id' }
  const evidence = `wallet lookup → ${json.chain_type ?? 'wallet'} ${short(address)}`
  const url = env('MONAD_TESTNET_RPC_URL')
  if (url === undefined) return { tier: 'credential', evidence, next: 'set MONAD_TESTNET_RPC_URL to read its nonce' }
  const [balance, nonce] = await Promise.all([rpc(url, 'eth_getBalance', [address, 'latest']), rpc(url, 'eth_getTransactionCount', [address, 'latest'])])
  const chain = `${mon(balance)}, nonce ${Number(nonce)} (10143)`
  return Number(nonce) > 0
    ? { tier: 'operation', evidence: `${evidence}; ${chain}: it has sent transactions`, next: 'end-to-end: its product flow (not provable read-only)' }
    : { tier: 'credential', evidence: `${evidence}; ${chain}`, next: 'a first eth_sendTransaction (this script sends none)' }
}

async function metamask(): Promise<Omit<Row, 'name'>> {
  const m = missing(['METAMASK_AGENT_WALLET_ADDRESS', 'MONAD_TESTNET_RPC_URL'])
  if (m) return m
  const address = env('METAMASK_AGENT_WALLET_ADDRESS')!
  const url = env('MONAD_TESTNET_RPC_URL')!
  const [balance, nonce] = await Promise.all([rpc(url, 'eth_getBalance', [address, 'latest']), rpc(url, 'eth_getTransactionCount', [address, 'latest'])])
  return {
    tier: 'unproven',
    evidence: `${short(address)}: ${mon(balance)}, nonce ${Number(nonce)} (10143)`,
    next: 'the login lives in the `mm` CLI: `mm doctor` and a signature prove the credential',
  }
}

async function completion(baseUrl: string, key: string, model: string): Promise<Omit<Row, 'name'>> {
  // The gateway's models reason first (~300 tokens for "ok"), so allow 512.
  const { status, json } = await http(`${baseUrl.replace(/\/$/, '')}/chat/completions`, {
    method: 'POST',
    headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
    body: JSON.stringify({ model, max_tokens: 512, messages: [{ role: 'user', content: 'Reply with the single word: ok' }] }),
  })
  const choice = json?.choices?.[0]
  if (choice === undefined) return { tier: 'failed', evidence: `${model} completion: HTTP ${status} ${String(json?.error?.message ?? '')}`.trim(), next: 'a valid key and model id' }
  const answer = String(choice.message?.content ?? '').trim().slice(0, 20)
  return {
    tier: 'operation',
    evidence: `${model} completion: finish_reason ${choice.finish_reason}, ${json.usage?.completion_tokens ?? '?'} output tokens, answer "${answer}"`,
    next: 'end-to-end: screening / arbiter in the board (not provable here)',
  }
}

async function aiGateway(): Promise<Omit<Row, 'name'>> {
  return missing(['AI_GATEWAY_API_KEY', 'SCREENING_MODEL']) ?? completion('https://ai-gateway.vercel.sh/v1', env('AI_GATEWAY_API_KEY')!, env('SCREENING_MODEL')!)
}

async function arbiterModel(): Promise<Omit<Row, 'name'>> {
  return (
    missing(['ARBITER_MODEL_BASE_URL', 'ARBITER_MODEL', 'ARBITER_MODEL_API_KEY']) ??
    completion(env('ARBITER_MODEL_BASE_URL')!, env('ARBITER_MODEL_API_KEY')!, env('ARBITER_MODEL')!)
  )
}

async function cre(): Promise<Omit<Row, 'name'>> {
  const m = missing(['CRE_WORKFLOW_OWNER', 'CRE_WORKFLOW_NAME'])
  if (m) return m
  return {
    tier: 'unproven',
    evidence: `workflow "${env('CRE_WORKFLOW_NAME')}" owner ${short(env('CRE_WORKFLOW_OWNER')!)}`,
    next: 'the login lives in the `cre` CLI: `cre whoami`, then deploy access',
  }
}

/** B7 preconditions on 143, read-only: role balances, registries, the allowlisted token and the CRE forwarder. */
async function mainnetReadiness(): Promise<Omit<Row, 'name'>> {
  const m = missing(['MONAD_MAINNET_RPC_URL'])
  if (m) return m
  if (mainnet === undefined) return { tier: 'failed', evidence: 'no contracts/config/monad-mainnet.json', next: 'the config' }
  const url = env('MONAD_MAINNET_RPC_URL')!
  const parts: string[] = []
  const gaps: string[] = []
  for (const [role, address] of Object.entries<string>(mainnet.roles ?? {})) {
    const [balance, nonce] = [await rpc(url, 'eth_getBalance', [address, 'latest']), await rpc(url, 'eth_getTransactionCount', [address, 'latest'])]
    parts.push(`${role} ${short(address)} ${mon(balance)} n${Number(nonce)}`)
    if (BigInt(balance) === 0n) gaps.push(`fund ${role}`)
  }
  const code: Array<[string, string | undefined]> = [
    ...Object.entries<string>(mainnet.erc8004 ?? {}),
    ['CRE forwarder', mainnet.cre?.forwarder],
    ...((mainnet.allowedTokens ?? []) as string[]).map((t): [string, string] => [`token ${short(t)}`, t]),
  ]
  for (const [label, address] of code) {
    if (address === undefined) continue
    const c = await rpc(url, 'eth_getCode', [address, 'latest'])
    if (c === '0x') gaps.push(`no code at ${label}`)
    else parts.push(`${label} has code`)
  }
  for (const token of (mainnet.allowedTokens ?? []) as string[]) {
    const decimals = Number(await rpc(url, 'eth_call', [{ to: token, data: '0x313ce567' }, 'latest']))
    parts.push(`${short(token)} decimals ${decimals}`)
  }
  const deployed = Object.keys(mainnet.deployment ?? {}).length > 0
  if (!deployed) gaps.push('the B7 deploy')
  return {
    tier: gaps.some((g) => g.startsWith('no code')) ? 'failed' : 'credential',
    evidence: `${parts.join('; ')} (143)`,
    next: gaps.join(', ') || 'end-to-end: a real USDC job',
  }
}

const probes: Array<[string, Probe]> = [
  ['Monad testnet RPC', () => monadRpc('MONAD_TESTNET_RPC_URL', 10143, 'end-to-end: the B1 deploy (not provable read-only)')],
  ['Monad mainnet RPC', () => monadRpc('MONAD_MAINNET_RPC_URL', 143, 'end-to-end: the B7 deploy')],
  ['ERC-8004 registries, Circle USDC', registries],
  ['Mainnet readiness (B7)', mainnetReadiness],
  ['Deployer EOA', () => eoa('DEPLOYER_PRIVATE_KEY', 'DEPLOYER_ADDRESS', 'admin')],
  ['Relay EOA', () => eoa('RELAY_PRIVATE_KEY', 'RELAY_ADDRESS', 'relay')],
  ['Attester EOA', () => eoa('ATTESTER_PRIVATE_KEY', 'ATTESTER_ADDRESS', 'attester')],
  ['Arbitrator EOA', () => eoa('ARBITRATOR_PRIVATE_KEY', 'ARBITRATOR_ADDRESS', 'arbitrator')],
  ['Testnet creator EOA', () => eoa('TESTNET_CREATOR_PRIVATE_KEY', 'TESTNET_CREATOR_ADDRESS', undefined)],
  ['Testnet worker EOA', () => eoa('TESTNET_WORKER_PRIVATE_KEY', 'TESTNET_WORKER_ADDRESS', undefined)],
  ['Privy server wallet', privy],
  ['MetaMask agent wallet', metamask],
  ['Etherscan v2 (Monadscan)', monadscan],
  ['Cloudflare', cloudflare],
  ['Envio HyperSync', hypersync],
  ['GitHub App', githubApp],
  ['Vercel AI Gateway', aiGateway],
  ['Arbitrator model endpoint', arbiterModel],
  ['Chainlink CRE', cre],
]

// --- Run ----------------------------------------------------------------------------------------------------------

const rows: Row[] = []
// One at a time: the public Monad RPC limits a caller to 15 requests/s.
for (const [name, probe] of probes) {
  try {
    rows.push({ name, ...(await probe()) })
  } catch (error) {
    rows.push({ name, tier: 'failed', evidence: error instanceof Error ? error.message : String(error), next: 'see evidence' })
  }
}

const now = new Date()
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const date = `${now.getUTCDate()} ${MONTHS[now.getUTCMonth()]} ${now.getUTCFullYear()}`
const cell = (text: string) => {
  const flat = redact(text).replace(/\|/g, '\\|').replace(/\s*\n\s*/g, ' ')
  return flat.length > 200 ? `${flat.slice(0, 199)}…` : flat
}
const lines = [
  `Reality check, ${now.toISOString()} (tiers: credential, operation; end-to-end is proven by the product flows)`,
  '',
  `| Dependency | Tier | Evidence (${date}) | Next tier needs |`,
  '| :--- | :--- | :--- | :--- |',
  ...rows.map((r) => `| ${cell(r.name)} | ${r.tier} | ${cell(r.evidence)} | ${cell(r.next)} |`),
]
console.log(lines.join('\n'))
