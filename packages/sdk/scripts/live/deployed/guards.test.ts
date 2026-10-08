import { describe, expect, it } from 'vitest'
import {
  assertReleased,
  assertSendBound,
  authorizationUrl,
  budgetRemaining,
  CAP_WEI,
  publicFailure,
  stageOrigin,
} from './guards.ts'
import { providerConfig, toolResult } from './codex.ts'

describe('deployed fixture boundaries', () => {
  it('recognizes OAuth only at the exact selected stage and authorize endpoint', () => {
    for (const origin of ['https://dev.sidequest.exchange', 'https://sidequest.exchange'] as const) {
      const url = `${origin}/oauth/authorize?client_id=fixture&state=fixture`
      expect(authorizationUrl(`Authorize at:\n${url}\n`, origin)).toBe(url)
      for (const bad of [
        'https://testnet.sidequest.xyz/oauth/authorize',
        `${origin}.evil.example/oauth/authorize`,
        `${origin}/oauth/token`,
        `https://evil.example/?next=${url}`,
      ])
        expect(authorizationUrl(bad, origin)).toBeUndefined()
    }
  })
  it('targets dev by default, prod only by name, and nothing else', () => {
    expect(stageOrigin(undefined)).toBe('https://dev.sidequest.exchange')
    expect(stageOrigin('')).toBe('https://dev.sidequest.exchange')
    expect(stageOrigin('https://sidequest.exchange')).toBe('https://sidequest.exchange')
    for (const bad of ['https://sidequest.exchange/', 'http://sidequest.exchange', 'https://evil.example']) {
      expect(() => stageOrigin(bad)).toThrow('P8_UNKNOWN_ORIGIN')
    }
  })

  it('requires the exact complete release marker', () => {
    const sha = 'a'.repeat(40)
    expect(() => assertReleased(sha, `READY ${sha}\n`)).toThrow()
    expect(() => assertReleased(sha.slice(0, 7), `RELEASED ${sha}\n`)).toThrow()
    expect(() => assertReleased(sha, `RELEASED ${'b'.repeat(40)}\n`)).toThrow()
    expect(() => assertReleased(sha, `RELEASED ${sha}\n`)).not.toThrow()
  })

  it('counts retained reservations and refuses a total above 2 MON', () => {
    expect(budgetRemaining([{ costWei: '10' }], { pending: '20' })).toBe(CAP_WEI - 30n)
    expect(() => budgetRemaining([{ costWei: CAP_WEI.toString() }], { pending: '1' })).toThrow()
    expect(() => budgetRemaining([{ costWei: '-1' }], {})).toThrow()
  })

  it('binds the entire actual send set to chain, gas, fee and native-value limits', () => {
    const bound = { maxGas: '100', maxFeePerGas: '10', nativeValueWei: '5', fromBlock: '1' }
    const tx = { chainId: 10143, gas: 50n, maxFeePerGas: 10n, value: 0n }
    expect(() => assertSendBound([tx, tx], bound, '1005')).not.toThrow()
    expect(() => assertSendBound([tx, tx, tx], bound, '1005')).toThrow()
    expect(() => assertSendBound([{ ...tx, gas: 101n }], bound, '1005')).toThrow()
    expect(() => assertSendBound([{ ...tx, maxFeePerGas: 11n }], bound, '1005')).toThrow()
    expect(() => assertSendBound([{ ...tx, value: 6n }], bound, '1005')).toThrow()
    expect(() => assertSendBound([{ ...tx, chainId: 143 }], bound, '1005')).toThrow()
    expect(() => assertSendBound([{ ...tx, maxFeePerGas: undefined }], bound, '1005')).toThrow()
    expect(() => assertSendBound([tx, tx], bound, '999')).toThrow()
    expect(() => assertSendBound([tx], { ...bound, maxGas: '-1' }, '1005')).toThrow()
    expect(() => budgetRemaining([{ costWei: (CAP_WEI + 1n).toString() }], {})).toThrow()
  })

  it('copies only the selected provider tables into isolated Codex config', () => {
    const config = providerConfig(
      'model_provider = "fixture"\n[mcp_servers.private]\nurl = "hidden"\n[model_providers.fixture]\nenv_key = "FIXTURE_KEY"\nbase_url = "http://127.0.0.1:8317/v1"\n[features]\nshell_tool = true\n',
    )
    expect(config.envKey).toBe('FIXTURE_KEY')
    expect(config.toml).toContain('[model_providers.fixture]')
    expect(config.toml).not.toContain('hidden')
    expect(config.toml).not.toContain('shell_tool')
  })

  it('requires actual MCP events with identical frozen arguments', () => {
    const args = { operationKey: 'fixture-key', taskId: 'fixture-job' }
    const event = JSON.stringify({
      type: 'item.completed',
      item: {
        type: 'mcp_tool_call',
        server: 'sidequest',
        tool: 'apply',
        arguments: { taskId: 'fixture-job', operationKey: 'fixture-key' },
        result: { content: [{ type: 'text', text: '{"ok":true}' }] },
      },
    })
    expect(toolResult(event, 'apply', args).output).toEqual({ ok: true })
    expect(() => toolResult(event, 'apply', { ...args, operationKey: 'changed' })).toThrow()
    expect(() =>
      toolResult(
        JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'Done' } }),
        'apply',
        args,
      ),
    ).toThrow()
    expect(() =>
      toolResult(
        `${event}\n${JSON.stringify({ type: 'item.completed', item: { type: 'command_execution' } })}`,
        'apply',
        args,
      ),
    ).toThrow()
  })

  it('never exposes raw provider, wallet or browser errors', () => {
    expect(publicFailure(new Error('token=private email=fixture@example.invalid'))).toBe(
      'P8_SCENARIO_FAILED_DETAILS_SUPPRESSED',
    )
    expect(publicFailure(new Error('P8_WRONG_CHAIN'))).toBe('P8_WRONG_CHAIN')
  })
})
