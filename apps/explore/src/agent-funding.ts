import { encodeFunctionData, getAddress, isAddress, maxUint256, parseAbi, parseUnits, type Hex } from 'viem'
import type { WalletStep } from './components/txOperation.ts'

export interface FundingAsset { id: string; symbol: string; decimals: number; address?: Hex }
export interface FundingRecord {
  id: string; owner: Hex; wallet: Hex; chainId: number
  amounts: Record<string, string>; estimatedGas: string; hashes?: string[]
}
const erc20 = parseAbi(['function transfer(address to, uint256 amount) returns (bool)'])

/** Reject precision loss, signs, exponents and unknown assets before freezing any wallet request. */
export function fundingAmount(text: string, asset: FundingAsset): bigint {
  if (text.trim() === '') return 0n
  const value = text.trim()
  if (!/^\d+(?:\.\d+)?$/.test(value) || (value.split('.')[1]?.length ?? 0) > asset.decimals)
    throw new Error(`Enter ${asset.symbol} with at most ${asset.decimals} decimal places.`)
  const amount = parseUnits(value, asset.decimals)
  if (amount > maxUint256) throw new Error(`${asset.symbol} amount is too large.`)
  return amount
}
export function fundingSteps(record: FundingRecord, assets: FundingAsset[], chainId: number, owner: string, wallet: string): WalletStep[] {
  if (record.chainId !== chainId || !isAddress(record.owner) || !isAddress(record.wallet) || getAddress(record.owner) !== getAddress(owner) || getAddress(record.wallet) !== getAddress(wallet) || record.owner.toLowerCase() === record.wallet.toLowerCase() || !/^fund_[a-z0-9-]+$/i.test(record.id))
    throw new Error('The saved funding review belongs to another wallet or network. Reconcile it before continuing.')
  if (!record.amounts || typeof record.amounts !== 'object' || Object.keys(record.amounts).some(id => !assets.some(asset => asset.id === id)))
    throw new Error('The funding review contains an unknown token.')
  if (typeof record.estimatedGas !== 'string' || !/^\d+$/.test(record.estimatedGas) || record.hashes !== undefined && (!Array.isArray(record.hashes) || !record.hashes.every(hash => typeof hash === 'string' && /^0x[0-9a-f]{64}$/i.test(hash))))
    throw new Error('The saved funding gas quote or receipts are invalid. Reconcile before continuing.')
  const steps = assets.flatMap(asset => {
    const text = record.amounts[asset.id] ?? ''
    if (typeof text !== 'string') throw new Error('Invalid funding amount.')
    const amount = fundingAmount(text, asset)
    if (amount === 0n) return []
    return [{
      description: `Send ${text.trim()} ${asset.symbol} to the agent`, chainId,
      to: asset.address ?? record.wallet,
      data: asset.address === undefined ? '0x' as Hex : encodeFunctionData({ abi: erc20, functionName: 'transfer', args: [record.wallet, amount] }),
      value: asset.address === undefined ? amount.toString() : '0',
    }]
  })
  if (steps.length === 0) throw new Error('Choose at least one amount to fund this agent.')
  if (record.hashes !== undefined && record.hashes.length !== steps.length)
    throw new Error('The saved funding receipts are incomplete. Reconcile before continuing.')
  return steps
}
