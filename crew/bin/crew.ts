#!/usr/bin/env bun
/**
 * The Sidequest crew: each member is a hosted agent its operator created on the site and connected here over OAuth,
 * run headless in its own `sidequest-crew` container on a schedule. No member holds a private key; Sidequest signs and
 * pays gas for it. Every member runs Codex CLI against the box's cliproxy with its own model (crew.json), and each
 * container is capped (CPUs, memory, pids) and weighted below interactive work and CI. State (OAuth tokens, harness
 * home, scratch work, cursors, transcripts) lives in `.crew/hosted/`, which git ignores.
 *
 *   bun crew/bin/crew.ts login <member>            print the consent link (sign in, pick the member's agent, approve)
 *   bun crew/bin/crew.ts login <member> '<url>'    finish with the page address the browser landed on
 *   bun crew/bin/crew.ts run <member> [note]       one routine pass (inbox, listing, work), then stop
 *   bun crew/bin/crew.ts loop [minutes]            check every enabled, connected member each interval; start a run
 *                                                  (in parallel) only when it has inbox events, held work or a listing due
 *   bun crew/bin/crew.ts status
 */
import { spawn, spawnSync } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { parseEnv } from 'node:util'

const crewDir = resolve(import.meta.dir, '..')
const repo = resolve(crewDir, '..')
const stateRoot = join(repo, '.crew', 'hosted')
const crew = JSON.parse(readFileSync(join(crewDir, 'crew.json'), 'utf8')) as Crew
const REDIRECT = 'http://127.0.0.1:8765/callback'
const IMAGE = 'sidequest-crew'

interface Resources { cpus: number; memory: string }
interface Member {
  name: string
  email: string
  operator: string
  model: string
  effort: string
  resources?: Resources
  enabled: boolean
  env: string[]
  mcp: Record<string, string>
  service: Record<string, unknown>
}
interface Crew {
  board: { mcp: string; origin: string; scopes: string }
  harness: { baseUrl: string; maxParallel: number; runTimeoutMinutes: number; cpuShares: number; resources: Resources }
  members: Record<string, Member>
}
interface Token { access_token: string; refresh_token: string; expires_at: number; agent_id: string; scope: string }

const json = (value: unknown) => JSON.stringify(value, null, 2) + '\n'
const secretFile = (path: string, value: unknown) => {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  writeFileSync(path, json(value), { mode: 0o600 })
  chmodSync(path, 0o600)
}
const readJson = <T>(path: string): T | undefined => (existsSync(path) ? (JSON.parse(readFileSync(path, 'utf8')) as T) : undefined)
const home = (member: string) => join(stateRoot, member)
const memberOf = (id: string | undefined): [string, Member] => {
  const m = id === undefined ? undefined : crew.members[id]
  if (m === undefined) throw new Error(`member must be one of: ${Object.keys(crew.members).join(', ')}`)
  return [id!, m]
}

function env(): Record<string, string> {
  const files = [join(repo, '.env.local'), join(process.env.HOME ?? '', '.config/secrets.env'), join(process.env.HOME ?? '', '.config/cliproxy.env')]
  const merged: Record<string, string> = {}
  for (const f of files) {
    if (!existsSync(f)) continue
    const text = readFileSync(f, 'utf8').replace(/^export /gm, '')
    Object.assign(merged, parseEnv(text))
  }
  return { ...merged, ...(process.env as Record<string, string>) }
}

async function form(path: string, body: Record<string, string>) {
  const res = await fetch(`${crew.board.origin}${path}`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(body) })
  const reply = (await res.json()) as Record<string, unknown>
  if (!res.ok) throw new Error(`${path}: ${res.status} ${String(reply.error_description ?? reply.error ?? '')}`)
  return reply
}

async function login(id: string, landed?: string) {
  const [, m] = memberOf(id)
  const clientPath = join(home(id), 'client.json')
  const loginPath = join(home(id), 'login.json')
  if (landed === undefined) {
    let client = readJson<{ clientId: string }>(clientPath)
    if (client === undefined) {
      const res = await fetch(`${crew.board.origin}/oauth/register`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ client_name: `Sidequest crew: ${m.name}`, redirect_uris: [REDIRECT] }) })
      const reg = (await res.json()) as { client_id?: string; error_description?: string }
      if (reg.client_id === undefined) throw new Error(`register: ${reg.error_description ?? res.status}`)
      client = { clientId: reg.client_id }
      secretFile(clientPath, client)
    }
    const verifier = randomBytes(32).toString('base64url')
    const state = randomBytes(12).toString('hex')
    secretFile(loginPath, { verifier, state })
    const q = new URLSearchParams({ response_type: 'code', client_id: client.clientId, redirect_uri: REDIRECT, scope: crew.board.scopes, resource: crew.board.mcp, state,
      code_challenge: createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256' })
    console.log(`Open this while signed in to ${crew.board.origin}, pick ${m.name}'s agent and approve. The browser then`)
    console.log(`lands on a page that does not load (${REDIRECT}?code=…); pass that whole address within 2 minutes:\n`)
    console.log(`${crew.board.origin}/oauth/authorize?${q}\n`)
    console.log(`  bun crew/bin/crew.ts login ${id} '<that address>'`)
    return
  }
  const client = readJson<{ clientId: string }>(clientPath)
  const pending = readJson<{ verifier: string; state: string }>(loginPath)
  if (client === undefined || pending === undefined) throw new Error(`run "login ${id}" first`)
  const url = new URL(landed)
  if (url.searchParams.get('error') !== null) throw new Error(`consent refused: ${url.searchParams.get('error')}`)
  if (url.searchParams.get('state') !== pending.state) throw new Error('that address is from a different login; start again')
  const t = await form('/oauth/token', { grant_type: 'authorization_code', code: url.searchParams.get('code') ?? '', redirect_uri: REDIRECT, client_id: client.clientId, code_verifier: pending.verifier, resource: crew.board.mcp })
  saveToken(id, t)
  console.log(`${m.name} connected as agent ${String(t.agent_id)} with ${String(t.scope)}`)
}

function saveToken(id: string, t: Record<string, unknown>) {
  secretFile(join(home(id), 'token.json'), { access_token: t.access_token, refresh_token: t.refresh_token, expires_at: Math.floor(Date.now() / 1000) + Number(t.expires_in ?? 3600), agent_id: String(t.agent_id), scope: String(t.scope) })
}

async function freshToken(id: string): Promise<Token> {
  const path = join(home(id), 'token.json')
  const t = readJson<Token>(path)
  const client = readJson<{ clientId: string }>(join(home(id), 'client.json'))
  if (t === undefined || client === undefined) throw new Error(`${id} is not connected; run "login ${id}"`)
  if (t.expires_at - Math.floor(Date.now() / 1000) > 600) return t
  saveToken(id, await form('/oauth/token', { grant_type: 'refresh_token', refresh_token: t.refresh_token, client_id: client.clientId, resource: crew.board.mcp }))
  return readJson<Token>(path)!
}

const bin = (name: string) => realpathSync(spawnSync('bash', ['-lc', `command -v ${name}`], { encoding: 'utf8' }).stdout.trim())

function prepareAgentDir(id: string): string {
  const agent = join(home(id), 'agent')
  mkdirSync(join(agent, 'state'), { recursive: true, mode: 0o700 })
  mkdirSync(join(agent, 'work'), { recursive: true })
  const role = join(crewDir, 'agents', id)
  for (const f of readdirSync(role)) {
    const from = join(role, f)
    if (statSync(from).isFile()) copyFileSync(realpathSync(from), join(agent, f))
  }
  // Skills are pinned by skills-lock.json and restored once per member, outside the container.
  if (!existsSync(join(agent, '.agents')) && !existsSync(join(agent, '.claude', 'skills'))) {
    spawnSync('npx', ['--yes', 'skills', 'experimental_install'], { cwd: agent, stdio: 'inherit' })
  }
  return agent
}

async function run(id: string, note = '') {
  const [, m] = memberOf(id)
  const token = await freshToken(id)
  const e = env()
  const agent = prepareAgentDir(id)
  const harnessHome = join(home(id), 'home')
  mkdirSync(join(harnessHome, '.codex'), { recursive: true, mode: 0o700 })
  writeFileSync(join(harnessHome, '.gitconfig'), `[user]\n\tname = ${m.name}\n\temail = ${m.email}\n[safe]\n\tdirectory = *\n[init]\n\tdefaultBranch = main\n`)
  const extraMcp = Object.entries(m.mcp).map(([n, url]) => `[mcp_servers.${n}]\nurl = "${url}"\n`).join('')
  writeFileSync(join(harnessHome, '.codex', 'config.toml'), `model = "${m.model}"\nmodel_provider = "cliproxy"\nmodel_reasoning_effort = "${m.effort}"\n[model_providers.cliproxy]\nname = "cliproxy"\nbase_url = "${crew.harness.baseUrl}"\nwire_api = "responses"\nenv_key = "CLIPROXY_API_KEY"\nrequires_openai_auth = false\n[mcp_servers.sidequest]\nurl = "${crew.board.mcp}"\nbearer_token_env_var = "SIDEQUEST_MCP_TOKEN"\n${extraMcp}[projects."/crew/agent"]\ntrust_level = "trusted"\n`)
  const service = { ...m.service, price: { model: 'quote', amountBaseUnits: '0', token: (await protocolInfo()).rewardTokens?.[0] } }
  const prompt = [
    `You are ${m.name}, the '${id}' member of the Sidequest crew and an autonomous hosted worker, agent ${token.agent_id}.`,
    'You run in a sandbox container; your working directory is /crew/agent (scratch work in /crew/agent/work, your state in /crew/agent/state).',
    'Read, in this order: /crew/agent/AGENTS.md (your role), /crew/shared/COMMON.md (crew rules) and /crew/skill/worker/SKILL.md (your procedure).',
    'Do one routine pass as COMMON.md describes, then stop.',
    `Your directory listing (for advertise_service): ${JSON.stringify(service)}`,
    note === '' ? '' : `Operator note for this run: ${note}`,
    `Your git identity is ${m.name} <${m.email}>. Chain: Monad testnet (10143). Board: ${crew.board.origin}. Be concise.`,
  ].filter(Boolean).join('\n')
  const envs: string[] = ['-e', 'HOME=/home/agent', '-e', 'TERM=dumb', '-e', 'LANG=C.UTF-8', '-e', 'PATH=/opt/bin:/opt/codex/bin:/opt/foundry:/usr/local/bin:/usr/bin:/bin',
    '-e', `SIDEQUEST_MCP_TOKEN=${token.access_token}`, '-e', `CLIPROXY_API_KEY=${e.CLIPROXY_API_KEY ?? ''}`,
    '-e', `GIT_AUTHOR_NAME=${m.name}`, '-e', `GIT_AUTHOR_EMAIL=${m.email}`, '-e', `GIT_COMMITTER_NAME=${m.name}`, '-e', `GIT_COMMITTER_EMAIL=${m.email}`]
  for (const v of m.env) envs.push('-e', v.includes('=') ? v : `${v}=${e[v] ?? ''}`)
  const mounts = ['-v', `${agent}:/crew/agent`, '-v', `${harnessHome}:/home/agent`, '-v', `${join(crewDir, 'shared')}:/crew/shared:ro`, '-v', `${join(repo, 'skill')}:/crew/skill:ro`,
    '-v', `${dirname(dirname(bin('codex')))}:/opt/codex:ro`, '-v', `${dirname(bin('forge'))}:/opt/foundry:ro`, '-v', `${bin('bun')}:/opt/bin/bun:ro`]
  const runs = join(home(id), 'runs')
  mkdirSync(runs, { recursive: true, mode: 0o700 })
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const container = `sq-crew-${id}`
  // One run per member at a time: the container name is the lock.
  if (spawnSync('docker', ['container', 'inspect', container], { stdio: 'ignore' }).status === 0) {
    console.log(`${m.name}: still running, skipped`)
    return
  }
  const { cpus, memory } = m.resources ?? crew.harness.resources
  const limits = ['--cpus', String(cpus), '--memory', memory, '--memory-swap', memory, '--pids-limit', '1024', '--cpu-shares', String(crew.harness.cpuShares)]
  const docker = ['run', '--rm', '-i', '--network', 'host', '--user', '1000:1000', '--name', container, ...limits, ...envs, ...mounts, IMAGE]
  const command = ['codex', 'exec', '--dangerously-bypass-approvals-and-sandbox', '--skip-git-repo-check', '--json', prompt]
  console.log(`${m.name} (${m.model}, ${cpus} CPU, ${memory}): run ${stamp}`)
  const out = Bun.file(join(runs, `${stamp}.jsonl`)).writer()
  const err: Buffer[] = []
  const child = spawn('docker', [...docker, ...command], { stdio: ['ignore', 'pipe', 'pipe'] })
  child.stdout.on('data', (chunk: Buffer) => out.write(chunk))
  child.stderr.on('data', (chunk: Buffer) => err.push(chunk))
  const timer = setTimeout(() => spawnSync('docker', ['stop', '--time', '20', container], { stdio: 'ignore' }), crew.harness.runTimeoutMinutes * 60_000)
  const code = await new Promise<number | null>((done) => child.on('close', done))
  clearTimeout(timer)
  await out.end()
  writeFileSync(join(runs, `${stamp}.err`), `${Buffer.concat(err).toString()}\nexit ${code}\n`, { mode: 0o600 })
  chmodSync(join(runs, `${stamp}.jsonl`), 0o600)
  const operator = join(agent, 'state', 'needs-operator')
  if (existsSync(operator)) console.log(`${m.name} needs the operator: ${readFileSync(operator, 'utf8').trim()}`)
  console.log(`${m.name}: exit ${code}`)
}

/** One MCP tool call as the member (JSON-RPC over the board's /mcp; no session needed). */
async function mcpCall<T = unknown>(token: string, name: string, args: Record<string, unknown> = {}): Promise<T> {
  const res = await fetch(crew.board.mcp, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: `Bearer ${token}` },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
  })
  const body = (await res.json()) as { result?: { content?: Array<{ text?: string }>; isError?: boolean } }
  const text = body.result?.content?.[0]?.text ?? ''
  if (body.result?.isError === true || !res.ok) throw new Error(`${name}: ${text.slice(0, 200) || res.status}`)
  const parsed = JSON.parse(text) as { ok?: boolean; result?: T }
  return (parsed.result ?? parsed) as T
}

const TERMINAL = new Set(['completed', 'cancelled', 'expired', 'closed', 'settled', 'ruled'])

/**
 * Whether a member has anything to do, read without starting a model: new inbox events past its saved cursor, held
 * work that is not finished, or a directory listing due for renewal (20 h). Idle members cost no model tokens.
 */
async function wakeReason(id: string): Promise<string | null> {
  const state = join(home(id), 'agent', 'state')
  // Members write the time they advertised as ISO 8601 (COMMON.md), but some write Unix seconds or milliseconds.
  const stamp = existsSync(join(state, 'advertised')) ? readFileSync(join(state, 'advertised'), 'utf8').trim() : ''
  const advertised = /^\d{10}$/.test(stamp) ? Number(stamp) * 1000 : /^\d{13}$/.test(stamp) ? Number(stamp) : Date.parse(stamp)
  if (!(Date.now() - advertised < 20 * 3600_000)) return 'listing due'
  const token = (await freshToken(id)).access_token
  const cursor = existsSync(join(state, 'cursor')) ? readFileSync(join(state, 'cursor'), 'utf8').trim() : ''
  const inbox = await mcpCall<{ events?: unknown[] }>(token, 'inbox', cursor === '' ? {} : { cursor })
  if ((inbox.events?.length ?? 0) > 0) return `${inbox.events!.length} inbox event(s)`
  const held = await mcpCall<Array<{ status?: string }>>(token, 'list_tasks', { role: 'worker', limit: 20 })
  const open = (Array.isArray(held) ? held : []).filter((t) => !TERMINAL.has(String(t.status ?? '')))
  if (open.length > 0) return `${open.length} held task(s)`
  return null
}

let info: { rewardTokens?: string[] } | undefined
async function protocolInfo() {
  info ??= (await (await fetch(`${crew.board.origin}/api/protocol_info`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).json() as { result: { rewardTokens?: string[] } }).result
  return info
}

function status() {
  const now = Math.floor(Date.now() / 1000)
  for (const [id, m] of Object.entries(crew.members)) {
    const t = readJson<Token>(join(home(id), 'token.json'))
    const runs = existsSync(join(home(id), 'runs')) ? readdirSync(join(home(id), 'runs')).filter((f) => f.endsWith('.jsonl')).toSorted() : []
    const operator = join(home(id), 'agent', 'state', 'needs-operator')
    console.log([`${m.name.padEnd(6)} ${id.padEnd(6)} ${m.model.padEnd(20)} ${m.operator.padEnd(5)}`, m.enabled ? '' : 'paused',
      t === undefined ? 'not connected' : `agent ${t.agent_id}, token ${t.expires_at > now ? `valid ${Math.round((t.expires_at - now) / 60)} min` : 'expired (refreshes on run)'}`,
      runs.length === 0 ? 'never run' : `last run ${runs.at(-1)!.replace('.jsonl', '')}`,
      existsSync(operator) ? 'NEEDS OPERATOR' : ''].filter(Boolean).join(' · '))
  }
}

const [command, a, b] = process.argv.slice(2)
if (command === 'login') await login(a!, b)
else if (command === 'run') await run(memberOf(a)[0], b)
else if (command === 'status') status()
else if (command === 'wake') console.log(await wakeReason(memberOf(a)[0]) ?? 'idle')
else if (command === 'loop') {
  // Each enabled, connected member loops on its own (start staggered), at most maxParallel containers at once.
  const minutes = Number(a ?? 15)
  let running = 0
  const slot = async () => {
    while (running >= crew.harness.maxParallel) await Bun.sleep(5_000)
    running++
  }
  const members = Object.entries(crew.members).filter(([id, m]) => m.enabled && existsSync(join(home(id), 'token.json')))
  console.log(`crew loop: ${members.map(([, m]) => m.name).join(', ')} every ${minutes} min, at most ${crew.harness.maxParallel} at once`)
  await Promise.all(members.map(async ([id], i) => {
    await Bun.sleep(i * 30_000)
    for (;;) {
      let reason: string | null = null
      try { reason = await wakeReason(id) } catch (error) { reason = `check failed (${(error as Error).message.slice(0, 80)})` }
      if (reason === null) console.log(`${crew.members[id]!.name}: idle`)
      else {
        await slot()
        console.log(`${crew.members[id]!.name}: waking, ${reason}`)
        try { await run(id) } catch (error) { console.error(`${id}: ${(error as Error).message}`) } finally { running-- }
      }
      await Bun.sleep(minutes * 60_000)
    }
  }))
} else {
  console.error('usage: crew.ts login <member> [url] | run <member> [note] | loop [minutes] | status')
  process.exit(2)
}
