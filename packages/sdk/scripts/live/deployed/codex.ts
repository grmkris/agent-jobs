/** Codex is the hosted MCP client; its final prose is never acceptance evidence. */
import { spawn } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { ORIGIN, authorizationUrl, required } from './guards.ts'
import { RunState } from './state.ts'
import { HostedBrowser, type ManagedAgent } from './browser.ts'

interface McpItem {
  type: string
  server?: string
  tool?: string
  arguments?: Record<string, unknown>
  result?: { content?: Array<{ type: string; text?: string }>; isError?: boolean }
  error?: unknown
}

export interface ToolResult {
  item: McpItem
  output: unknown
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (value !== null && typeof value === 'object')
    return `{${Object.entries(value)
      .toSorted(([a], [b]) => a.localeCompare(b))
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonical(entry)}`)
      .join(',')}}`
  return JSON.stringify(value)
}

/** Copy only the selected provider's tables; never hooks, MCPs, skills or auth.json. */
export function providerConfig(config: string): { toml: string; envKey?: string } {
  const selected = /^model_provider\s*=\s*"([a-zA-Z0-9_-]+)"/m.exec(config)?.[1]
  if (selected === undefined) throw new Error('P8_CODEX_PROVIDER_NOT_CONFIGURED')
  const tables = config.split(/(?=^\[)/m).filter((part) => {
    const header = /^\[([^\]]+)\]/.exec(part)?.[1]
    return header === `model_providers.${selected}` || header?.startsWith(`model_providers.${selected}.`) === true
  })
  if (tables.length === 0) throw new Error('P8_CODEX_PROVIDER_TABLE_MISSING')
  const provider = tables.join('\n')
  const envKey = /^env_key\s*=\s*"([A-Z0-9_]+)"/m.exec(provider)?.[1]
  const model = /^model\s*=\s*"[^"\r\n]+"/m.exec(config)?.[0]
  return {
    toml: `${model === undefined ? '' : `${model}\n`}model_provider = "${selected}"\nmcp_oauth_credentials_store = "file"\n${provider}\n`,
    ...(envKey === undefined ? {} : { envKey }),
  }
}

export function toolResult(events: string, name: string, expected: Record<string, unknown>): ToolResult {
  const items = events
    .split('\n')
    .filter(Boolean)
    .flatMap((line) => {
      const event = JSON.parse(line) as { type?: string; item?: McpItem }
      if (event.type !== 'item.completed' || event.item === undefined) return []
      if (['command_execution', 'web_search', 'file_change'].includes(event.item.type))
        throw new Error('P8_CODEX_UNEXPECTED_TOOL')
      return event.item.type === 'mcp_tool_call' ? [event.item] : []
    })
  const target = items.filter((item) => item.server === 'sidequest' && item.tool === name)
  if (items.some((item) => item.server !== 'sidequest' || (item.tool !== name && item.tool !== 'get_instructions')))
    throw new Error('P8_CODEX_UNEXPECTED_MCP_CALL')
  if (target.length === 0) throw new Error('P8_CODEX_NO_TOOL_RESULT')
  for (const item of target) {
    if (JSON.stringify(item.arguments) !== JSON.stringify(expected)) {
      // Property order is irrelevant but no extra field or changed value is tolerated.
      if (canonical(item.arguments) !== canonical(expected)) throw new Error('P8_CODEX_CHANGED_FROZEN_ARGUMENTS')
    }
  }
  const item = target.at(-1)!
  if ((item.error !== null && item.error !== undefined) || item.result === undefined)
    throw new Error('P8_CODEX_MCP_TRANSPORT_FAILED')
  const contents = item.result.content?.filter((entry) => entry.type === 'text').map((entry) => entry.text ?? '') ?? []
  const joined = contents.join('\n')
  let output: unknown = joined
  try {
    output = JSON.parse(joined)
  } catch {
    // get_instructions and denial replies are plain text.
  }
  return { item, output }
}

export class CodingClient {
  readonly home: string
  readonly workdir: string
  readonly env: NodeJS.ProcessEnv

  constructor(
    readonly run: RunState,
    readonly clientId = 'worker',
  ) {
    const saved = run.get<string>(`codex-home/${clientId}`)
    this.home = saved ?? run.set(`codex-home/${clientId}`, mkdtempSync(join(tmpdir(), 'sidequest-p8-codex-')))
    if (!existsSync(this.home)) throw new Error('P8_CODEX_HOME_LOST_RECONCILE_BEFORE_RECONNECT')
    chmodSync(this.home, 0o700)
    this.workdir = join(this.home, 'work')
    mkdirSync(this.workdir, { mode: 0o700, recursive: true })
    const provider = providerConfig(readFileSync(join(homedir(), '.codex/config.toml'), 'utf8'))
    const config = join(this.home, 'config.toml')
    if (!existsSync(config)) writeFileSync(config, provider.toml, { mode: 0o600 })
    else {
      const current = readFileSync(config, 'utf8')
      const model = /^model\s*=.*$/m.exec(provider.toml)?.[0]
      if (model !== undefined && !/^model\s*=/m.test(current))
        writeFileSync(config, `${model}\n${current}`, { mode: 0o600 })
    }
    this.env = { PATH: process.env.PATH, LANG: 'C.UTF-8', CODEX_HOME: this.home }
    if (provider.envKey !== undefined) this.env[provider.envKey] = required(provider.envKey)
  }

  async #process(
    args: string[],
    label: string,
    observe?: (output: string, input: (text: string) => void, kill: () => void) => Promise<void>,
  ): Promise<string> {
    const path = join(this.run.directory, `${this.clientId}-${label}.private.log`)
    const child = spawn('codex', args, {
      env: this.env,
      cwd: this.workdir,
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: true,
    })
    let stdout = ''
    let stderr = ''
    let observation: Promise<void> = Promise.resolve()
    let observationError: unknown
    const kill = () => {
      if (child.pid !== undefined) {
        try {
          process.kill(-child.pid, 'SIGKILL')
        } catch {
          /* Already exited. */
        }
      }
    }
    child.stdout.on('data', (chunk) => {
      stdout += String(chunk)
      writeFileSync(path, JSON.stringify({ stream: 'stdout', bytes: Buffer.byteLength(stdout) }), {
        mode: 0o600,
      })
      if (observe !== undefined)
        observation = observation
          .then(() => observe(stdout, (text) => child.stdin.write(text), kill))
          .catch((error) => {
            observationError = error
            kill()
          })
    })
    child.stderr.on('data', (chunk) => {
      stderr += String(chunk)
      writeFileSync(`${path}.stderr`, JSON.stringify({ stream: 'stderr', bytes: Buffer.byteLength(stderr) }), {
        mode: 0o600,
      })
      if (observe !== undefined)
        observation = observation
          .then(() => observe(`${stdout}\n${stderr}`, (text) => child.stdin.write(text), kill))
          .catch((error) => {
            observationError = error
            kill()
          })
    })
    const timer = setTimeout(kill, 180_000)
    const terminate = () => {
      if (child.pid !== undefined) {
        try {
          process.kill(-child.pid, 'SIGTERM')
        } catch {
          /* Already exited. */
        }
      }
    }
    process.once('SIGTERM', terminate)
    process.once('SIGINT', terminate)
    try {
      const code = await new Promise<number | null>((resolve, reject) => {
        child.once('error', reject)
        child.once('exit', resolve)
      })
      await observation
      if (observationError !== undefined) throw observationError
      if (code !== 0) throw new Error('P8_CODEX_PROCESS_FAILED')
      return stdout
    } finally {
      clearTimeout(timer)
      process.removeListener('SIGTERM', terminate)
      process.removeListener('SIGINT', terminate)
      terminate()
    }
  }

  async connect(browser: HostedBrowser, agent: ManagedAgent): Promise<void> {
    if (this.run.get(`codex-connected/${this.clientId}`) === true) return
    if (this.run.get(`codex-added/${this.clientId}`) !== true) {
      // Current Codex automatically starts OAuth during `mcp add`. This fixture
      // must use its controlled no-browser login below, so configure only its
      // isolated home directly, preserving credentials from any interrupted add.
      const config = join(this.home, 'config.toml')
      const current = readFileSync(config, 'utf8')
      if (current.includes('[mcp_servers.sidequest]')) {
        if (!current.includes(`url = "${ORIGIN}/mcp"`)) throw new Error('P8_CODEX_SERVER_ORIGIN_CHANGED')
      } else writeFileSync(config, `${current}\n[mcp_servers.sidequest]\nurl = "${ORIGIN}/mcp"\n`, { mode: 0o600 })
      this.run.set(`codex-added/${this.clientId}`, true)
    }
    let opened = false
    let callback = false
    await this.#process(
      ['mcp', 'login', 'sidequest', '--no-browser', '--scopes', 'sidequest:read,sidequest:work,sidequest:hire'],
      'login',
      async (output, input) => {
        if (opened) return
        // OAuth must return to the exact stage under test. The old fixture host was
        // testnet.sidequest.xyz; prod acceptance uses sidequest.exchange.
        const candidate = authorizationUrl(output)
        if (candidate === undefined) return
        opened = true
        const url = new URL(candidate)
        if (url.origin !== ORIGIN) throw new Error('P8_UNEXPECTED_OAUTH_ORIGIN')
        await browser.page.goto(url.href, { waitUntil: 'domcontentloaded' })
        await browser.page.getByRole('combobox').selectOption(agent.id)
        await browser.page
          .getByRole('button', { name: 'Use this agent for this connection', exact: true })
          .waitFor({ timeout: 30_000 })
        browser.page.on('request', (request) => {
          const redirected = new URL(request.url())
          if (
            callback ||
            !['localhost', '127.0.0.1', '[::1]'].includes(redirected.hostname) ||
            !redirected.searchParams.has('code')
          )
            return
          callback = true
          input(`${redirected.href}\n`)
        })
        await browser.click('Use this agent for this connection')
      },
    )
    this.run.set(`codex-connected/${this.clientId}`, true)
  }

  async call(name: string, args: Record<string, unknown>, label: string): Promise<ToolResult> {
    this.run.freeze(`mcp-intent/${label}`, { name, args })
    const prompt = `You are a bounded acceptance client. Call only the sidequest MCP tool ${name} exactly once with these exact JSON arguments: ${JSON.stringify(args)}. Do not execute shell commands, search the web, edit files, schedule work, call other tools, or add arguments. Return the tool result; do not claim completion from your own prose. If the call fails, stop. Never alter a brief or spend to work around a refusal.`
    const output = await this.#process(
      ['exec', '--json', '--ephemeral', '--skip-git-repo-check', '--sandbox', 'read-only', prompt],
      label,
    )
    const result = toolResult(output, name, args)
    this.run.set(`mcp-result/${label}`, result)
    return result
  }

  /** Probe the actual OAuth credentials stored by Codex without exposing them. */
  async assertRevoked(): Promise<void> {
    const tokens = new Set<string>()
    const visit = (value: unknown): void => {
      if (value === null || typeof value !== 'object') return
      for (const [key, entry] of Object.entries(value)) {
        if ((key === 'access_token' || key === 'accessToken') && typeof entry === 'string') tokens.add(entry)
        else visit(entry)
      }
    }
    for (const file of readdirSync(this.home).filter((name) => name.endsWith('.json'))) {
      try {
        visit(JSON.parse(readFileSync(join(this.home, file), 'utf8')))
      } catch {
        /* Not an OAuth record. */
      }
    }
    if (tokens.size !== 1) throw new Error('P8_CODEX_OAUTH_TOKEN_UNAVAILABLE')
    const response = await fetch(`${ORIGIN}/mcp`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${[...tokens][0]}`,
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' }),
      signal: AbortSignal.timeout(30_000),
    })
    if (response.status !== 401) throw new Error('P8_REVOKED_MCP_ACCESS_STILL_USABLE')
  }

  /** Lose the confirmed response before the client can durably record its result. */
  async interrupt(name: string, args: Record<string, unknown>, label: string): Promise<void> {
    this.run.freeze(`mcp-intent/${label}`, { name, args })
    let interrupted = false
    try {
      await this.#process(
        [
          'exec',
          '--json',
          '--ephemeral',
          '--skip-git-repo-check',
          '--sandbox',
          'read-only',
          `You are a bounded acceptance client. Call only the sidequest MCP tool ${name} exactly once with these exact JSON arguments: ${JSON.stringify(args)}. Do not execute shell commands, search the web, edit files, schedule work, call other tools, or add arguments.`,
        ],
        `${label}-interrupted`,
        async (output, _input, kill) => {
          if (interrupted) return
          const events = output
            .split('\n')
            .filter((line) => {
              try {
                return JSON.parse(line).type === 'item.completed'
              } catch {
                return false
              }
            })
            .join('\n')
          if (!events.includes('mcp_tool_call')) return
          const result = toolResult(events, name, args)
          const envelope = result.output as {
            ok?: boolean
            result?: {
              status?: string
              operationId?: string
              result?: { sponsorship?: { txHash?: string } }
            }
          }
          if (
            envelope.ok !== true ||
            envelope.result?.status !== 'confirmed' ||
            envelope.result.result?.sponsorship?.txHash === undefined
          )
            throw new Error('P8_INTERRUPT_OPERATION_NOT_CONFIRMED')
          this.run.freeze(`interrupted/${label}`, {
            operationId: envelope.result.operationId,
            txHash: envelope.result.result.sponsorship.txHash,
            boundary: 'Codex killed after MCP confirmation, before durable local result',
          })
          interrupted = true
          kill()
        },
      )
    } catch (error) {
      if (interrupted && error instanceof Error && error.message === 'P8_CODEX_PROCESS_FAILED') return
      throw error
    }
    throw new Error('P8_CODEX_INTERRUPT_DID_NOT_TRIGGER')
  }
}
