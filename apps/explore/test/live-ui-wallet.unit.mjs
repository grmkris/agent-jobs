import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { encodeFunctionData, hashTypedData, keccak256, parseAbi, recoverTypedDataAddress } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { liveWallet } from './live-ui-wallet.mjs'

const config = JSON.parse(readFileSync(new URL('../../../contracts/config/monad-testnet.json', import.meta.url), 'utf8'))
const calldata = encodeFunctionData({ abi: parseAbi(['function requestUnstake(uint256 amount)']), functionName: 'requestUnstake', args: [1n] })
const account = privateKeyToAccount(`0x${'11'.repeat(32)}`)

function clients() {
  const calls = { raw: [], prepared: 0 }
  const raw = '0x02' + '11'.repeat(80)
  const reads = {
    getChainId: async () => 10143,
    getTransactionCount: async () => 0,
    getBalance: async () => 2_000_000_000_000_000_000n,
    getCode: async () => '0x',
    getTransactionReceipt: async () => { throw Object.assign(new Error('pending'), { name: 'TransactionReceiptNotFoundError' }) },
    getTransaction: async () => { throw Object.assign(new Error('missing'), { name: 'TransactionNotFoundError' }) },
    sendRawTransaction: async ({ serializedTransaction }) => { calls.raw.push(serializedTransaction); return keccak256(serializedTransaction) },
  }
  const wallet = {
    prepareTransactionRequest: async () => { calls.prepared += 1; return { gas: 21_000n, maxFeePerGas: 1n } },
    signTransaction: async () => raw,
  }
  return { reads, wallet, calls }
}

function state() { return mkdtempSync(join(tmpdir(), 'sidequest-live-ui-')) }

// Browser JSON uses string chainId. The resulting signature must match the
// contract's canonical Permit domain, including chainId, across journal resume.
{
  const dir = state()
  const typed = {
    domain: { name: 'Factory', version: '1', chainId: 10143, verifyingContract: config.deployment.sidequest.factory },
    types: { Permit: [{ name: 'owner', type: 'address' }, { name: 'spender', type: 'address' }, { name: 'value', type: 'uint256' }, { name: 'nonce', type: 'uint256' }, { name: 'deadline', type: 'uint256' }] },
    primaryType: 'Permit',
    message: { owner: account.address, spender: config.deployment.sidequest.vault, value: 20_000_000_000_000_000_000n, nonce: 0n, deadline: 1_800_000_000n },
  }
  const browser = JSON.parse(JSON.stringify(typed, (_, value) => typeof value === 'bigint' ? value.toString() : value))
  browser.domain.chainId = '10143'
  const request = { method: 'eth_signTypedData_v4', params: [account.address, JSON.stringify(browser)] }
  const first = liveWallet({ account, config, stateDir: dir, enabled: true, clients: clients() })
  first.setRow('permit')
  const signature = await first.request(request)
  assert.equal(await recoverTypedDataAddress({ ...typed, signature }), account.address)
  assert.equal(signature, await account.signTypedData(typed))
  assert.notEqual(hashTypedData(browser), hashTypedData(typed), 'string domain without explicit types would omit chainId')
  first.close()
  browser.types.EIP712Domain = [{ name: 'name', type: 'string' }, { name: 'version', type: 'string' }, { name: 'chainId', type: 'uint256' }, { name: 'verifyingContract', type: 'address' }]
  const second = liveWallet({ account, config, stateDir: dir, enabled: true, clients: clients() })
  second.setRow('permit-with-domain-types')
  assert.equal(await second.request({ method: 'eth_signTypedData_v4', params: [account.address, browser] }), signature)
  assert.equal(await second.request(request), signature)
  await assert.rejects(() => second.request({ method: 'eth_signTypedData_v4', params: [account.address, { ...browser, domain: { ...browser.domain, chainId: '143' } }] }), /another typed-data chain/)
  second.close()
  rmSync(dir, { recursive: true, force: true })
}

// Read-only mode exposes account/read methods but refuses both signatures and sends.
{
  const dir = state()
  const w = liveWallet({ account, config, stateDir: dir, enabled: false, clients: clients() })
  assert.deepEqual(await w.request({ method: 'eth_accounts' }), [account.address])
  await assert.rejects(() => w.request({ method: 'eth_sendTransaction', params: [{ to: config.deployment.sidequest.vault, data: calldata }] }), /Read-only mode/)
  await assert.rejects(() => w.request({ method: 'personal_sign', params: ['hello', account.address] }), /Read-only mode/)
  w.close()
  rmSync(dir, { recursive: true, force: true })
}

// A journal is bound to the exact promoted deployment and cannot be reused after G1b changes it.
{
  const dir = state()
  const first = liveWallet({ account, config, stateDir: dir, enabled: true, clients: clients() })
  first.setRow('binding')
  await first.request({ method: 'eth_sendTransaction', params: [{ from: account.address, chainId: 10143, to: config.deployment.sidequest.vault, data: calldata, value: 0 }] })
  first.close()
  const changed = structuredClone(config)
  changed.deployment.sidequest.block += 1
  assert.throws(() => liveWallet({ account, config: changed, stateDir: dir, enabled: false, clients: clients() }), /different deployment/)
  rmSync(dir, { recursive: true, force: true })
}

// The same exact signed bytes are the only retry after an ambiguous broadcast; two processes cannot share a journal.
{
  const dir = state()
  const firstClients = clients()
  const first = liveWallet({ account, config, stateDir: dir, enabled: true, clients: firstClients })
  first.setRow('K6-01')
  const tx = { from: account.address, chainId: 10143, to: config.deployment.sidequest.vault, data: calldata, value: 0 }
  const hash = await first.request({ method: 'eth_sendTransaction', params: [tx] })
  assert.equal(firstClients.calls.prepared, 1)
  assert.throws(() => liveWallet({ account, config, stateDir: dir, enabled: true, clients: clients() }), /already in use/)
  first.close()
  const secondClients = clients()
  const second = liveWallet({ account, config, stateDir: dir, enabled: true, clients: secondClients })
  second.setRow('K6-01')
  assert.equal(await second.request({ method: 'eth_sendTransaction', params: [tx] }), hash)
  assert.deepEqual(secondClients.calls.raw, [firstClients.calls.raw[0]])
  secondClients.reads.getTransactionCount = async () => 1
  await assert.rejects(() => second.request({ method: 'eth_sendTransaction', params: [tx] }), /nonce consumed/)
  assert.equal(secondClients.calls.raw.length, 1)
  await assert.rejects(() => second.request({ method: 'eth_sendTransaction', params: [{ ...tx, to: config.deployment.sidequest.safe }] }), /unexpected target/)
  second.close()
  rmSync(dir, { recursive: true, force: true })
}

console.log('PASS: LIVE-UI canonical typed data, read-only, deployment binding, lock and exact-byte retry')
