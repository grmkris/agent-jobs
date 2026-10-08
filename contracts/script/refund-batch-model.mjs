import { encodeFunctionData, erc20Abi, parseAbi, parseTransaction, keccak256, recoverTransactionAddress } from 'viem'
import { address, canonical, checksum, validateManifest } from './refund-model.mjs'

export const refundVaultAbi = parseAbi([
  'function delegateFor(address account,address delegator,uint256 amount)',
  'function factory() view returns(address)',
  'function isHolding(address) view returns(bool)',
])

export function refundPlan(manifest, config, identity) {
  validateManifest(manifest, identity)
  const h = config?.deployment?.sidequest
  if (config.chainId !== 10143 || config.network !== 'monad-testnet' || !Number.isSafeInteger(h?.block)
    || h.block <= manifest.snapshot.block || address(h.vault) === address(manifest.old.vault)
    || address(h.factory) === address(manifest.old.factory)) throw new Error('refund: requires promoted replacement testnet contracts')
  if (h.block !== manifest.snapshot.block + 1) throw new Error('refund: snapshot must precede the new deployment by one block')
  const funding = address(config.sidequest.allocation.ecosystem)
  const totalPositions = manifest.positions.reduce((n, row) => n + BigInt(row.amount), 0n)
  const operations = [
    ...(totalPositions === 0n ? [] : [{ key: 'approval', to: address(h.factory), amount: totalPositions.toString(),
      data: encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [address(h.vault), totalPositions] }) }]),
    ...manifest.positions.map(row => ({ key: `position/${row.account.toLowerCase()}/${row.delegator.toLowerCase()}`,
      to: address(h.vault), amount: row.amount,
      data: encodeFunctionData({ abi: refundVaultAbi, functionName: 'delegateFor', args: [address(row.account), address(row.delegator), BigInt(row.amount)] }) })),
    ...manifest.transfers.map(row => ({ key: `transfer/${row.wallet.toLowerCase()}`, to: address(h.factory), amount: row.amount,
      data: encodeFunctionData({ abi: erc20Abi, functionName: 'transfer', args: [address(row.wallet), BigInt(row.amount)] }) })),
  ]
  const binding = canonical({ purpose: `${manifest.to}-refunds-v1`, chainId: 10143, manifest: manifest.checksum, funding,
    deployment: checksum(config), factory: address(h.factory), vault: address(h.vault) })
  return { funding, factory: address(h.factory), vault: address(h.vault), holding: address(config.deployment.main.holding), operations, binding }
}

export function bindRefundJournal(state, plan) {
  if (state.binding && state.binding !== plan.binding) throw new Error('refund: journal binding changed; never reset or reuse signed sends')
  if (!state.binding && (Object.keys(state.sends).length || Object.keys(state.values).length)) throw new Error('refund: unbound journal contains effects')
  for (const key of Object.keys(state.sends)) {
    if (!plan.operations.some(operation => operation.key === key)) throw new Error('refund: journal contains an unknown operation')
  }
  state.binding = plan.binding
}

export async function validateSavedRefunds(state, plan) {
  for (const [key, saved] of Object.entries(state.sends)) {
    const intent = plan.operations.find(operation => operation.key === key)
    if (!intent) throw new Error(`refund: saved signed intent mismatch for ${key}`)
    const tx = parseTransaction(saved.raw)
    const sender = await recoverTransactionAddress({ serializedTransaction: saved.raw })
    if (!intent || keccak256(saved.raw) !== saved.hash || address(saved.wallet) !== plan.funding || address(sender) !== plan.funding
      || tx.chainId !== 10143 || tx.nonce !== saved.nonce || address(tx.to) !== intent.to || tx.data !== intent.data
      || (tx.value ?? 0n) !== 0n || tx.type !== 'eip1559') throw new Error(`refund: saved signed intent mismatch for ${key}`)
  }
}

// Pure resume decision, tested separately from RPC: a receipt is required before an effect counts as paid.
export function resumeDecision(saved, receipt, latestNonce) {
  if (!saved) return 'prepare'
  if (receipt) {
    if (receipt.transactionHash !== saved.hash || receipt.status !== 'success') throw new Error('refund: saved transaction failed or receipt mismatch')
    return 'confirmed'
  }
  if (latestNonce > saved.nonce) throw new Error('refund: nonce consumed without the saved receipt; reconcile manually')
  return 'replay-original-bytes'
}

export function refundSendMode(yes, env) {
  if (!yes) return false
  if (env.SIDEQUEST_TESTNET_SEND !== '1') throw new Error('refund: --yes also requires SIDEQUEST_TESTNET_SEND=1')
  return true
}
