import * as sdk from '@sidequest/sdk'
import { concat, decodeFunctionData, encodeAbiParameters, hashTypedData, keccak256, slice, zeroAddress } from 'viem'
import { describe as group, expect, it } from 'vitest'
import {
  MULTI_SEND_CALL_ONLY,
  atomically,
  calldata,
  describe,
  ecdsaSignature,
  execSigned,
  execTransaction,
  multiSend,
  preValidated,
  safeAbi,
  safeTxTypedData,
  unpackMultiSend,
  walletSignature,
} from './safe.ts'

const owner = '0x1111111111111111111111111111111111111111'
const vault = '0x2222222222222222222222222222222222222222'

group('acting as the Safe', () => {
  it('signs as a pre-validated owner: r = the owner, s = 0, v = 1', () => {
    const sig = preValidated(owner)
    expect(sig.length).toBe(2 + 65 * 2)
    expect(slice(sig, 12, 32)).toBe(owner)
    expect(slice(sig, 32, 64)).toBe(`0x${'0'.repeat(64)}`)
    expect(slice(sig, 64)).toBe('0x01')
  })
  it('wraps the inner call in execTransaction as a plain call with no refund', () => {
    const inner = calldata({
      contract: 'StakeVault',
      to: vault,
      abi: sdk.stakeVaultAbi,
      functionName: 'revokeHolding',
      args: ['0x3333333333333333333333333333333333333333'],
    })
    const { functionName, args } = decodeFunctionData({
      abi: safeAbi,
      data: execTransaction(owner, { to: vault, data: inner }),
    })
    expect(functionName).toBe('execTransaction')
    expect(args).toEqual([
      vault,
      0n,
      inner,
      0,
      0n,
      0n,
      0n,
      '0x0000000000000000000000000000000000000000',
      '0x0000000000000000000000000000000000000000',
      preValidated(owner),
    ])
  })
  it('reads a call back from its calldata, arguments by name', () => {
    const data = calldata({
      contract: 'FeeSchedule',
      to: vault,
      abi: sdk.feeScheduleAbi,
      functionName: 'propose',
      args: [{ thresholds: [0n, 1n, 2n, 3n], bps: [3000, 1000, 300, 100], treasury: owner }],
    })
    expect(describe(sdk.feeScheduleAbi, data)).toEqual({
      functionName: 'propose',
      args: [['s', `{ thresholds: [0, 1, 2, 3], bps: [3000, 1000, 300, 100], treasury: ${owner} }`]],
    })
    expect(
      describe(
        sdk.miningReserveAbi,
        calldata({
          contract: 'MiningReserve',
          to: vault,
          abi: sdk.miningReserveAbi,
          functionName: 'fund',
          args: [0n, 5n],
        }),
      ),
    ).toEqual({
      functionName: 'fund',
      args: [
        ['epoch', '0'],
        ['amount', '5'],
      ],
    })
  })
})

group('one atomic Safe transaction (D13)', () => {
  const core = '0x4444444444444444444444444444444444444444'
  const evaluator = '0x5555555555555555555555555555555555555555'
  const pause = calldata({ contract: 'Core', to: core, abi: sdk.coreAbi, functionName: 'pause' })
  const note = calldata({
    contract: 'SidequestEvaluator',
    to: evaluator,
    abi: sdk.sidequestEvaluatorAbi,
    functionName: 'notePause',
  })
  it('packs plain calls for MultiSendCallOnly and reads them back', () => {
    expect(
      unpackMultiSend(
        multiSend([
          { to: core, data: pause },
          { to: evaluator, data: note },
        ]),
      ),
    ).toEqual([
      { operation: 0, to: core, value: 0n, data: pause },
      { operation: 0, to: evaluator, data: note, value: 0n },
    ])
    expect(unpackMultiSend('0x12345678')).toBeNull()
  })
  it('sends them as one execTransaction that delegatecalls MultiSendCallOnly', () => {
    const { args } = decodeFunctionData({
      abi: safeAbi,
      data: atomically(owner, [
        { to: core, data: pause },
        { to: evaluator, data: note },
      ]),
    })
    expect(args[0]).toBe(MULTI_SEND_CALL_ONLY)
    expect(args[3]).toBe(1)
    expect(args[9]).toBe(preValidated(owner))
  })
})

group('a Safe transaction signed for one nonce (D18)', () => {
  const safe = '0x1006582a6d0C40E19eAbd1847C652D48b88BD5bF'
  const inner = { to: vault, data: '0x3ccfd60b' } as const
  it('hashes as Safe v1.4.1 does, from its own type hashes', () => {
    // Safe.sol: DOMAIN_SEPARATOR_TYPEHASH and SAFE_TX_TYPEHASH. The page's typed data must give the same hash; the
    // live testnet Safe's getTransactionHash agreed with it at two nonces (checked once, read-only, 2 Oct).
    const domain = keccak256(
      encodeAbiParameters(
        [{ type: 'bytes32' }, { type: 'uint256' }, { type: 'address' }],
        ['0x47e79534a245952e8b16893a336b85a3d9ea9fa8c573f3d803afb92a79469218', 10143n, safe],
      ),
    )
    const struct = keccak256(
      encodeAbiParameters(
        [
          'bytes32',
          'address',
          'uint256',
          'bytes32',
          'uint8',
          'uint256',
          'uint256',
          'uint256',
          'address',
          'address',
          'uint256',
        ].map((type) => ({ type })),
        [
          '0xbb8310d486368db6bd6f849402fdd73ad53d316b5a4b2644ad6efe0f941286d8',
          inner.to,
          0n,
          keccak256(inner.data),
          0,
          0n,
          0n,
          0n,
          zeroAddress,
          zeroAddress,
          9n,
        ],
      ),
    )
    expect(hashTypedData(safeTxTypedData(10143, safe, inner, 9n))).toBe(keccak256(concat(['0x1901', domain, struct])))
    expect(hashTypedData(safeTxTypedData(10143, safe, inner, 10n))).not.toBe(
      keccak256(concat(['0x1901', domain, struct])),
    )
  })

  it('takes a 65-byte signature with v 27 or 28, never a pre-validated or contract one; a wallet’s v 0 or 1 is written as 27 or 28', () => {
    const rs = `0x${'ab'.repeat(64)}` as const
    expect(ecdsaSignature(`${rs}1b`)).toBe(`${rs}1b`)
    expect(ecdsaSignature(`${rs}1c`)).toBe(`${rs}1c`)
    expect(ecdsaSignature(`${rs}00`)).toBeNull()
    expect(ecdsaSignature(`${rs}01`)).toBeNull()
    expect(ecdsaSignature(preValidated(owner))).toBeNull()
    expect(walletSignature(`${rs}00`)).toBe(`${rs}1b`)
    expect(walletSignature(`${rs}01`)).toBe(`${rs}1c`)
    expect(walletSignature(`${rs}1c`)).toBe(`${rs}1c`)
    expect(walletSignature(`${rs}20`)).toBeNull()
    expect(ecdsaSignature(`${rs}20`)).toBeNull()
    expect(ecdsaSignature('0x1b')).toBeNull()
    const { args } = decodeFunctionData({ abi: safeAbi, data: execSigned(`${rs}1c`, inner) })
    expect(args[9]).toBe(`${rs}1c`)
    expect(args[3]).toBe(0)
  })
})
