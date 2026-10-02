import { decodeFunctionData, encodeFunctionResult, keccak256, parseAbi, parseEther, toHex, type Hex } from 'viem'
import { expect, test } from 'vitest'
import mainnet from '../../../contracts/config/monad-mainnet.json' with { type: 'json' }
import { assertLaunchGate } from '../src/deploy-preflight.ts'
import { launchOwnedContracts, liveLaunchGate, opensAdmission, relayFloorWei, type ChainConfig, type LaunchReader } from '../src/prod-config.ts'
import { parseHostedAdmission } from '@agent-jobs/board'

const abi = parseAbi([
  'function owner() view returns (address)',
  'function ADMIN_ROLE() view returns (bytes32)',
  'function DEFAULT_ADMIN_ROLE() view returns (bytes32)',
  'function hasRole(bytes32 role, address account) view returns (bool)',
  'function verifiers(address account) view returns (bool)',
])
const a = (n: number) => `0x${n.toString(16).padStart(40, '0')}` as const
const SAFE = a(0x5afe)
const addresses = { core: a(0xc0), holding: a(0x10), evaluator: a(0x11), vault: a(0x12), feeSchedule: a(0x13), distributor: a(0x14), miningReserve: a(0x15) }
const DEFAULT_ADMIN = toHex(0, { size: 32 })
const ADMIN = keccak256(toHex('ADMIN_ROLE'))
const FLOOR = parseEther('2')
const lower = (value: string) => value.toLowerCase()

/** A promoted mainnet config: the six owned by the Safe and the core's roles with it. */
function promoted(): ChainConfig {
  const config = structuredClone(mainnet) as unknown as ChainConfig
  config.deployment = {
    network: 'monad-mainnet', block: 123, core: addresses.core, factory: a(0xfa),
    main: { kind: 'hireling-v1', factory: a(0xfa), holding: addresses.holding, evaluator: addresses.evaluator, openTokens: true },
    hireling: { block: 123, safe: SAFE, factory: a(0xfa), vault: addresses.vault, feeSchedule: addresses.feeSchedule, distributor: addresses.distributor, miningReserve: addresses.miningReserve, teamVesting: a(0x16), t0: 1_791_500_000 },
  }
  return config
}

interface LiveState {
  code: Record<string, Hex>
  owners: Record<string, string>
  roles: Record<string, Set<string>>
  verifiers: Set<string>
  balances: Record<string, bigint>
  /** reads that fail, as `method:address` (`call:<to>:<function>` for calls) */
  failing: Set<string>
}

function live(config: ChainConfig): LiveState {
  const owners = Object.fromEntries(Object.values(addresses).filter(value => value !== addresses.core).map(value => [lower(value), SAFE]))
  return {
    code: { [lower(SAFE)]: '0x6080' },
    owners,
    roles: { [DEFAULT_ADMIN]: new Set([lower(SAFE)]), [ADMIN]: new Set([lower(SAFE)]) },
    verifiers: new Set([lower(config.roles.attester!)]),
    balances: { [lower(config.roles.relay!)]: FLOOR + 1n },
    failing: new Set(),
  }
}

/** A read-only fake chain; it has no way to write, so a refusal cannot be followed by a mutation through it. */
function reader(state: LiveState): LaunchReader & { reads: string[] } {
  const reads: string[] = []
  return {
    reads,
    async code(address) {
      reads.push(`code:${lower(address)}`)
      if (state.failing.has(`code:${lower(address)}`)) throw new Error('rpc down')
      return state.code[lower(address)] ?? '0x'
    },
    async balance(address) {
      reads.push(`balance:${lower(address)}`)
      if (state.failing.has(`balance:${lower(address)}`)) throw new Error('rpc down')
      return state.balances[lower(address)] ?? 0n
    },
    async call(to, data) {
      const { functionName, args } = decodeFunctionData({ abi, data })
      reads.push(`call:${lower(to)}:${functionName}`)
      if (state.failing.has(`call:${lower(to)}:${functionName}`)) throw new Error('rpc down')
      const encode = (result: unknown) => encodeFunctionResult({ abi, functionName, result } as never)
      switch (functionName) {
        case 'owner': {
          const owner = state.owners[lower(to)]
          if (owner === undefined) return '0x'
          return encode(owner)
        }
        case 'ADMIN_ROLE': return encode(ADMIN)
        case 'DEFAULT_ADMIN_ROLE': return encode(DEFAULT_ADMIN)
        case 'hasRole': return encode(state.roles[args![0] as string]?.has(lower(args![1] as string)) ?? false)
        case 'verifiers': return encode(lower(to) === lower(addresses.evaluator) && state.verifiers.has(lower(args![0] as string)))
      }
      throw new Error('unexpected call')
    },
  }
}

const gate = async (mutate: (state: LiveState, config: ChainConfig) => void = () => {}, options: { floor: bigint | undefined } = { floor: FLOOR }) => {
  const config = promoted()
  const state = live(config)
  mutate(state, config)
  return liveLaunchGate(config, reader(state), options.floor)
}

test('D16: a promoted deployment with the Safe in custody, a verifier attester and a funded relay passes', async () => {
  expect(await gate()).toEqual([])
})

// ---- PROD-GATE-001: the Safe owns all six ----

test('PROD-GATE-001: a missing Safe, a Safe without code, or an unreadable Safe refuses', async () => {
  expect(await gate((_, config) => { delete config.deployment.hireling!.safe })).toEqual(['launch:safe unset'])
  expect(await gate((_, config) => { config.deployment.hireling!.safe = null })).toEqual(['launch:safe unset'])
  expect(await gate(state => { state.code = {} })).toEqual(['launch:safe has no code'])
  expect(await gate(state => { state.failing.add(`code:${lower(SAFE)}`) })).toEqual(['launch:safe code unreadable'])
})

test.each(launchOwnedContracts)('PROD-GATE-001: %s still owned by the deployer (Safe only pending) refuses', async name => {
  const failures = await gate((state, config) => { state.owners[lower(addresses[name])] = config.roles.admin! })
  expect(failures).toEqual([`launch:owner:${name} is not the Safe`])
})

test.each(launchOwnedContracts)('PROD-GATE-001: an unreadable owner() on %s refuses', async name => {
  expect(await gate(state => { state.failing.add(`call:${lower(addresses[name])}:owner`) })).toEqual([`launch:owner:${name} unreadable`])
  expect(await gate(state => { delete state.owners[lower(addresses[name])] })).toEqual([`launch:owner:${name} unreadable`])
})

// ---- PROD-GATE-002: both core admin roles with the Safe, none with the deployer ----

test.each([
  ['DEFAULT_ADMIN_ROLE not with the Safe', (s: LiveState) => { s.roles[DEFAULT_ADMIN]!.delete(lower(SAFE)) }, 'launch:core DEFAULT_ADMIN_ROLE not held by the Safe'],
  ['ADMIN_ROLE not with the Safe', (s: LiveState) => { s.roles[ADMIN]!.delete(lower(SAFE)) }, 'launch:core ADMIN_ROLE not held by the Safe'],
  ['DEFAULT_ADMIN_ROLE still with the deployer', (s: LiveState, c: ChainConfig) => { s.roles[DEFAULT_ADMIN]!.add(lower(c.roles.admin!)) }, 'launch:core DEFAULT_ADMIN_ROLE still held by the deployer'],
  ['ADMIN_ROLE still with the deployer', (s: LiveState, c: ChainConfig) => { s.roles[ADMIN]!.add(lower(c.roles.admin!)) }, 'launch:core ADMIN_ROLE still held by the deployer'],
] as const)('PROD-GATE-002: %s refuses', async (_, mutate, expected) => {
  expect(await gate(mutate)).toEqual([expected])
})

test('PROD-GATE-002: custody is read live; a stale record of roles.admin proves nothing, and failed role reads refuse', async () => {
  // The config still names the old admin as deployer, but the role has since moved to yet another key.
  const failures = await gate(state => {
    state.roles[ADMIN] = new Set([lower(a(0xbad))])
  })
  expect(failures).toEqual(['launch:core ADMIN_ROLE not held by the Safe'])
  expect(await gate(state => { state.failing.add(`call:${lower(addresses.core)}:hasRole`) })).toEqual([
    'launch:core DEFAULT_ADMIN_ROLE of the Safe unreadable', 'launch:core DEFAULT_ADMIN_ROLE of the deployer unreadable',
    'launch:core ADMIN_ROLE of the Safe unreadable', 'launch:core ADMIN_ROLE of the deployer unreadable',
  ])
  expect(await gate(state => { state.failing.add(`call:${lower(addresses.core)}:ADMIN_ROLE`) })).toEqual(['launch:core ADMIN_ROLE unreadable'])
  expect(await gate((_, config) => { config.roles.admin = SAFE })).toContain('launch:deployer must be a separate account')
})

// ---- PROD-GATE-003: the attester verifies on the v1 Evaluator ----

test('PROD-GATE-003: an attester that is not (or no longer) a verifier refuses; an unreadable flag refuses', async () => {
  expect(await gate(state => { state.verifiers.clear() })).toEqual(['launch:attester is not a verifier on the v1 Evaluator'])
  expect(await gate(state => { state.failing.add(`call:${lower(addresses.evaluator)}:verifiers`) })).toEqual(['launch:attester verifier unreadable'])
})

// ---- PROD-GATE-004: the relay holds strictly more than RELAY_FLOOR_MAINNET ----

test.each([
  ['zero', 0n],
  ['below the floor', FLOOR - 1n],
  ['exactly at the floor', FLOOR],
])('PROD-GATE-004: a relay balance %s refuses', async (_, balance) => {
  expect(await gate((state, config) => { state.balances[lower(config.roles.relay!)] = balance })).toEqual(['launch:relay at or below RELAY_FLOOR_MAINNET'])
})

test('PROD-GATE-004: an unreadable balance or an undefined floor refuses; the relay is the configured role, not any funded address', async () => {
  expect(await gate((state, config) => { state.failing.add(`balance:${lower(config.roles.relay!)}`) })).toEqual(['launch:relay balance unreadable'])
  expect(await gate(() => {}, { floor: undefined })).toEqual(['launch:relay floor undefined (RELAY_FLOOR_MAINNET, @agent-jobs/sdk)'])
  expect(await gate((state, config) => {
    state.balances = { [lower(a(0xf00d))]: parseEther('100') }
    expect(config.roles.relay).not.toBe(a(0xf00d))
  })).toEqual(['launch:relay at or below RELAY_FLOOR_MAINNET'])
  expect(relayFloorWei('2')).toBe(FLOOR)
  expect(relayFloorWei(FLOOR)).toBe(FLOOR)
  expect(relayFloorWei(undefined)).toBeUndefined()
})

test('D16: failure labels carry no values beyond role names', async () => {
  const failures = await gate((state, config) => {
    state.code = {}
    state.verifiers.clear()
    state.balances[lower(config.roles.relay!)] = 0n
  })
  expect(failures.join(' ')).not.toMatch(/0x[0-9a-fA-F]{8,}/)
})

// ---- wiring: only a deploy that opens admission needs the gate ----

test('D16: missing, empty, 0 and false open admission and need the gate; explicit drained values agree with the Worker', async () => {
  for (const value of [undefined, '', '0', 'false', 'FALSE']) expect(opensAdmission(value)).toBe(true)
  for (const value of ['1', 'true', 'drain', ' 0']) {
    expect(opensAdmission(value)).toBe(false)
    expect(parseHostedAdmission(value).drain).toBe(true)
  }
  for (const value of ['0', 'false']) expect(parseHostedAdmission(value).drain).toBe(false)
})

test('D16: an opening deploy is refused before anything else when the gate fails; a drained deploy is not gated', async () => {
  const config = promoted()
  const state = live(config)
  state.owners[lower(addresses.vault)] = config.roles.admin!
  const chain = reader(state)
  await expect(assertLaunchGate(config, '0', chain, FLOOR)).rejects.toThrow('production launch gate refused: launch:owner:vault is not the Safe')
  await expect(assertLaunchGate(config, undefined, chain, FLOOR)).rejects.toThrow('launch:owner:vault')
  const reads = chain.reads.length
  await expect(assertLaunchGate(config, '1', chain, FLOOR)).resolves.toBeUndefined()
  expect(chain.reads.length).toBe(reads)
  state.owners[lower(addresses.vault)] = SAFE
  await expect(assertLaunchGate(config, '0', chain, FLOOR)).resolves.toBeUndefined()
})
