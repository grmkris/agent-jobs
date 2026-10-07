import * as sdk from '@sidequest/sdk'
import {
  createAllowedCalldataTerms,
  createAllowedMethodsTerms,
  createAllowedTargetsTerms,
  createERC20TransferAmountTerms,
  createLimitedCallsTerms,
  createTimestampTerms,
  createValueLteTerms,
  encodeDelegations,
  hashDelegation,
} from '@metamask/delegation-core'
import { DELEGATOR_CONTRACTS } from '@metamask/delegation-deployments'
import {
  type Address,
  type Hex,
  concat,
  decodeFunctionData,
  domainSeparator,
  encodePacked,
  keccak256,
  pad,
  recoverTypedDataAddress,
  toFunctionSelector,
} from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { describe, expect, it } from 'vitest'
import mainnet from '../../../../contracts/config/monad-mainnet.json' with { type: 'json' }
import testnet from '../../../../contracts/config/monad-testnet.json' with { type: 'json' }
import {
  DELEGATION_TYPES,
  ROOT_AUTHORITY,
  advanceExecution,
  budgetDelegation,
  delegationDigest,
  delegationDomain,
  delegationHash,
  delegationManagerAbi,
  delegationTypedData,
  disableCalldata,
  redeemCalldata,
} from '@sidequest/sdk'
type AdvanceBudget = Parameters<typeof budgetDelegation>[1] & { kind: 'advance' }
type CallBudget = Parameters<typeof budgetDelegation>[1] & { kind: 'call' }

const d = sdk.deployment('monad-testnet')
const creator = privateKeyToAccount(`0x${'11'.repeat(32)}`)
const worker = '0x2222222222222222222222222222222222222222' as Address
const token = '0xDEef53f34fa71C46E7bB6E34d42d4cF36987C44E' as Address
const salt = keccak256('0x01')
const until = 1_800_000_000
const advance: AdvanceBudget = { kind: 'advance', token, cap: 2_000_000n, expiresAt: until }
const call: CallBudget = { kind: 'call', target: token, function: 'function faucet()', cap: 0n, expiresAt: until }

const struct = (x: ReturnType<typeof budgetDelegation>) => ({ ...x, caveats: x.caveats.map((c) => ({ ...c })) })
const lower = (cs: Array<{ enforcer: Address; terms: Hex; args: Hex }>) =>
  cs.map((c) => ({ ...c, terms: c.terms.toLowerCase() }))

describe('the framework on Monad is the one in the config (MetaMask Delegation Framework v1.3.0)', () => {
  const name: Record<string, string> = {
    erc20TransferAmount: 'ERC20TransferAmountEnforcer',
    erc20PeriodTransfer: 'ERC20PeriodTransferEnforcer',
    allowedCalldata: 'AllowedCalldataEnforcer',
    valueLte: 'ValueLteEnforcer',
    allowedTargets: 'AllowedTargetsEnforcer',
    allowedMethods: 'AllowedMethodsEnforcer',
    limitedCalls: 'LimitedCallsEnforcer',
    timestamp: 'TimestampEnforcer',
  }
  for (const [network, cfg] of [
    ['monad-testnet', testnet],
    ['monad-mainnet', mainnet],
  ] as const) {
    it(`${network}: manager, DeleGator and every enforcer are MetaMask's published deployment`, () => {
      const published = DELEGATOR_CONTRACTS['1.3.0']?.[cfg.chainId] as Record<string, string>
      expect(cfg.delegation.manager).toBe(published.DelegationManager)
      expect(cfg.delegation.delegator).toBe(published.EIP7702StatelessDeleGatorImpl)
      for (const [key, address] of Object.entries(cfg.delegation.enforcers))
        expect(address, key).toBe(published[name[key] as string])
    })
  }
})

describe('a budget as a delegation (ADR-0009)', () => {
  it('an advance: no value, the token, the cap, the worker as the only recipient, the expiry', () => {
    const x = budgetDelegation(d, advance, creator.address, worker, salt, until)
    expect(x).toMatchObject({
      delegate: worker,
      delegator: creator.address,
      authority: ROOT_AUTHORITY,
      salt: BigInt(salt),
      signature: '0x',
    })
    const e = d.delegation.enforcers
    expect(x.caveats).toEqual(
      lower([
        { enforcer: e.valueLte, terms: createValueLteTerms({ maxValue: 0n }), args: '0x' },
        {
          enforcer: e.erc20TransferAmount,
          terms: createERC20TransferAmountTerms({ tokenAddress: token, maxAmount: 2_000_000n }),
          args: '0x',
        },
        {
          enforcer: e.allowedCalldata,
          terms: createAllowedCalldataTerms({ startIndex: 4, value: pad(worker, { size: 32 }) }),
          args: '0x',
        },
        {
          enforcer: e.timestamp,
          terms: createTimestampTerms({ afterThreshold: 0, beforeThreshold: until }),
          args: '0x',
        },
      ]),
    )
  })

  it('a call: one target, one function, the value cap, one call, the expiry', () => {
    const x = budgetDelegation(d, call, creator.address, worker, salt, until)
    const e = d.delegation.enforcers
    expect(x.caveats).toEqual(
      lower([
        { enforcer: e.allowedTargets, terms: createAllowedTargetsTerms({ targets: [token] }), args: '0x' },
        {
          enforcer: e.allowedMethods,
          terms: createAllowedMethodsTerms({ selectors: [toFunctionSelector('function faucet()')] }),
          args: '0x',
        },
        { enforcer: e.valueLte, terms: createValueLteTerms({ maxValue: 0n }), args: '0x' },
        { enforcer: e.limitedCalls, terms: createLimitedCallsTerms({ limit: 1 }), args: '0x' },
        {
          enforcer: e.timestamp,
          terms: createTimestampTerms({ afterThreshold: 0, beforeThreshold: until }),
          args: '0x',
        },
      ]),
    )
  })

  it('the hash is the framework’s, and the signed digest is its EIP-712 digest under the manager’s domain', () => {
    const x = budgetDelegation(d, advance, creator.address, worker, salt, until)
    expect(delegationHash(x)).toBe(hashDelegation(struct(x)))
    const separator = domainSeparator({ domain: delegationDomain(d) })
    expect(delegationDigest(d, x)).toBe(keccak256(concat(['0x1901', separator, delegationHash(x)])))
  })

  it('the typed-data JSON a wallet signs recovers to the creator over that digest', async () => {
    const x = budgetDelegation(d, advance, creator.address, worker, salt, until)
    const signature = await sdk.signTypedDataJson(
      {
        account: creator,
        signTypedData: (a: Parameters<typeof creator.signTypedData>[0]) => creator.signTypedData(a),
      } as never,
      delegationTypedData(d, x),
    )
    const signer = await recoverTypedDataAddress({
      domain: delegationDomain(d),
      types: DELEGATION_TYPES,
      primaryType: 'Delegation',
      message: { ...x, caveats: x.caveats.map((c) => ({ enforcer: c.enforcer, terms: c.terms })) },
      signature,
    })
    expect(signer).toBe(creator.address)
  })

  it('redeem: the signed delegation as the permission context, single mode, the transfer as packed execution', () => {
    const x = { ...budgetDelegation(d, advance, creator.address, worker, salt, until), signature: '0xabcd' as Hex }
    const data = redeemCalldata(x, advanceExecution(token, worker, 500_000n))
    const { functionName, args } = decodeFunctionData({ abi: delegationManagerAbi, data })
    expect(functionName).toBe('redeemDelegations')
    const [contexts, modes, executions] = args as unknown as [Hex[], Hex[], Hex[]]
    expect(contexts).toEqual([encodeDelegations([struct(x)])])
    expect(modes).toEqual([pad('0x00', { size: 32 })])
    expect(executions).toEqual([
      encodePacked(['address', 'uint256', 'bytes'], [token, 0n, advanceExecution(token, worker, 500_000n).callData]),
    ])
  })

  it('revoke: disableDelegation with the same delegation', () => {
    const x = budgetDelegation(d, call, creator.address, worker, salt, until)
    const { functionName, args } = decodeFunctionData({ abi: delegationManagerAbi, data: disableCalldata(x) })
    expect(functionName).toBe('disableDelegation')
    expect(args[0]).toMatchObject({ delegate: worker, delegator: creator.address, salt: BigInt(salt) })
  })
})
