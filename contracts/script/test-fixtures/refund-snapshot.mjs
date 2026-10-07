/** Synthetic ABI-encoded pre-G1d share positions and canonical readbacks. No live evidence claims. */
import { encodeAbiParameters, encodeEventTopics } from 'viem'
import { KRIS, oldVaultAbi } from '../refund-model.mjs'
export const addr = digit => `0x${digit.repeat(40)}`
export const hash = digit => `0x${digit.repeat(64)}`
export function snapshotFixture() {
  const old = { block: 100, vault: addr('a'), factory: addr('b'), core: addr('c'), holding: addr('d'), configChecksum: hash('e') }
  let index = 0
  const emit = (name, args) => {
    const event = oldVaultAbi.find(item => item.type === 'event' && item.name === name)
    const dataInputs = event.inputs.filter(input => !input.indexed)
    const topics = encodeEventTopics({ abi: [event], eventName: name, args })
    return { address: old.vault, block_number: 100 + index, log_index: index++, transaction_hash: hash('1'), topic0: topics[0], topic1: topics[1] ?? null, topic2: topics[2] ?? null, topic3: topics[3] ?? null,
      data: encodeAbiParameters(dataInputs, dataInputs.map(input => args[input.name])) }
  }
  const vaultLogs = [
    emit('Delegated', { account: addr('1'), delegator: addr('1'), payer: addr('1'), assets: 1000n, shares: 1000n }),
    emit('Delegated', { account: addr('1'), delegator: addr('2'), payer: addr('9'), assets: 1000n, shares: 1000n }),
    emit('UndelegateRequested', { account: addr('1'), delegator: addr('1'), shares: 500n, assets: 500n, queuedShares: 500n, unlockAt: 500n }),
    emit('Slashed', { account: addr('1'), holding: old.holding, amount: 500n }),
    emit('Delegated', { account: addr('3'), delegator: addr('4'), payer: addr('4'), assets: 500n, shares: 500n }),
    emit('Slashed', { account: addr('3'), holding: old.holding, amount: 500n }),
    emit('PoolReset', { account: addr('3'), generation: 1n }),
    emit('Delegated', { account: addr('3'), delegator: addr('3'), payer: addr('3'), assets: 300n, shares: 300n }),
  ]
  return { chainId: 10143, block: 110, blockHash: hash('2'), timestamp: 1000, old, vaultLogs,
    accounts: [
      { account: addr('1'), pool: { assets: '1500', reserved: '100', shares: '2000', queuedShares: '500', generation: '0' }, positions: [
        { delegator: addr('1'), shares: '1000', queuedShares: '500', unlockAt: 500, generation: '0', assets: '750' },
        { delegator: addr('2'), shares: '1000', queuedShares: '0', unlockAt: 0, generation: '0', assets: '750' },
      ] },
      { account: addr('3'), pool: { assets: '300', reserved: '0', shares: '300', queuedShares: '0', generation: '1' }, positions: [
        { delegator: addr('4'), shares: '0', queuedShares: '0', unlockAt: 0, generation: '1', assets: '0' },
        { delegator: addr('3'), shares: '300', queuedShares: '0', unlockAt: 0, generation: '1', assets: '300' },
      ] },
    ], totalAssets: '1800', looseBalances: [{ wallet: KRIS, amount: '100000', sources: ['explicit Kris balance'] }], excluded: [
      { wallet: addr('8'), amount: '9997000', reason: 'faucet' }, { wallet: addr('9'), amount: '179999999', reason: 'ecosystem' },
    ] }
}
export function configFixture(funding) {
  return { network: 'monad-testnet', chainId: 10143, roles: { admin: addr('9') }, sidequest: { allocation: { ecosystem: funding } }, deployment: { core: addr('f'), sidequest: { block: 111, vault: addr('5'), factory: addr('6') }, main: { holding: addr('7') } } }
}
