import { expect, it } from 'vitest'
import { deployment, encodeBackerShare, identityAbi, BACKER_SHARE_KEY } from '@sidequest/sdk'
import { decodeFunctionData } from 'viem'
import { tools } from '../src/tools.ts'
import type { Board } from '@sidequest/board'

// SAFETY: this preparation tool must not access the board or a hosted signer; a throwing double enforces that.
const board = new Proxy(
  {},
  {
    get() {
      throw new Error('must not access board')
    },
  },
) as Board

it('prepares owner-confirmed metadata without sending or using a hosted signer', () => {
  const result = tools.set_backer_share!.run(
    board,
    {},
    { agentId: '4242', bps: 5000 },
    { network: 'monad-testnet', mcpSession: undefined },
  )
  const tx = { to: deployment('monad-testnet').identity, data: expect.any(String), value: '0' }
  expect(result).toEqual({ transaction: tx, chainId: 10143, requiresWalletConfirmation: true })
  // SAFETY: the tool response is the preparation object verified above; only inspect its calldata.
  const { transaction } = result as { transaction: { data: `0x${string}` } }
  expect(decodeFunctionData({ abi: identityAbi, data: transaction.data })).toEqual({
    functionName: 'setMetadata',
    args: [4242n, BACKER_SHARE_KEY, encodeBackerShare(5000)],
  })
  expect(tools.set_backer_share!.description).toContain('ERC-8004 owner')
  expect(tools.set_backer_share!.description).toContain('next mining epoch')
})

it.each([-1, 10001, 0.5, '5000', undefined])('rejects invalid bps %s before wallet preparation', (bps) => {
  expect(() =>
    tools.set_backer_share!.run(
      board,
      {},
      { agentId: '4242', bps },
      { network: 'monad-testnet', mcpSession: undefined },
    ),
  ).toThrow()
})

it.each(['0', '-1', '01', '', 'not-an-id'])('rejects invalid agent ID %s', (agentId) => {
  expect(() =>
    tools.set_backer_share!.run(board, {}, { agentId, bps: 0 }, { network: 'monad-testnet', mcpSession: undefined }),
  ).toThrow()
})
