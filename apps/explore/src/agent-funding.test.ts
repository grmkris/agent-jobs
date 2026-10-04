import { decodeFunctionData, parseAbi } from 'viem'
import { expect, it } from 'vitest'
import { fundingAmount, fundingSteps, type FundingAsset, type FundingRecord } from './agent-funding.ts'
import { txJournalKey } from './components/txJournal.ts'
const owner='0x1111111111111111111111111111111111111111' as const,wallet='0x2222222222222222222222222222222222222222' as const,token='0x3333333333333333333333333333333333333333' as const
const assets: FundingAsset[]=[{id:'native',symbol:'MON',decimals:18},{id:token,address:token,symbol:'mUSD',decimals:6}]
const record: FundingRecord={id:'fund_test',owner,wallet,chainId:10143,amounts:{native:'0.5',[token]:'2.1'},estimatedGas:'0'}
it('freezes exact native and ERC-20 transfers to the child, with no allowance or staking authority',()=>{
  const steps=fundingSteps(record,assets,10143,owner,wallet)
  expect(steps[0]).toMatchObject({to:wallet,data:'0x',value:'500000000000000000'})
  const transfer=decodeFunctionData({abi:parseAbi(['function transfer(address,uint256)']),data:steps[1]!.data})
  expect(steps[1]?.to).toBe(token)
  expect(transfer).toMatchObject({functionName:'transfer',args:[wallet,2100000n]})
  expect(txJournalKey('fund',steps)).not.toBe(txJournalKey('fund',[{...steps[0]!,value:'1'},steps[1]!]))
})
it('refuses rounding, unknown assets, another sender/recipient/chain and empty funding',()=>{
  for(const text of ['0.0000001','-1','1e6','NaN','1.'])expect(()=>fundingAmount(text,assets[1]!)).toThrow()
  for(const changed of [{...record,chainId:143},{...record,owner:wallet},{...record,wallet:owner},{...record,amounts:{unknown:'1'}},{...record,amounts:{native:'0'}}])expect(()=>fundingSteps(changed,assets,10143,owner,wallet)).toThrow()
  expect(()=>fundingSteps({...record,hashes:[]},assets,10143,owner,wallet)).toThrow(/incomplete/)
})
