import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { parseEnv } from 'node:util'
import { createPublicClient, createWalletClient, http, keccak256 } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'

export const loadEnv = () => {
  const local = process.env.SIDEQUEST_STAGE === 'local' || process.env.SIDEQUEST_STAGE === undefined
  const env = { ...process.env, ...(local ? parseEnv(readFileSync(resolve('.env.local'), 'utf8')) : {}) }
  return { ...env, MONAD_RPC_URL: env.MONAD_RPC_URL || (local ? env.MONAD_TESTNET_RPC_URL : undefined) }
}
const json = value => JSON.stringify(value, (_key, item) => typeof item === 'bigint' ? item.toString() : item, 2) + '\n'

/** Persist signed bytes before broadcasting. An interrupted operation reconciles its original hash;
 * a reverted receipt requires a new reviewed operation, never an automatic replacement. Testnet only. */
export async function testnetOperation({ id, key, to, data = '0x', value = 0n, gas = 100_000n, env = loadEnv() }) {
  if (!/^[a-z0-9-]+$/.test(id)) throw new Error('invalid-operation-id')
  if (env.SIDEQUEST_TESTNET_SEND !== '1') throw new Error('testnet-send-not-enabled')
  const client = createPublicClient({ transport: http(env.MONAD_RPC_URL) })
  if (await client.getChainId() !== 10143) throw new Error('testnet-chain-mismatch')
  const account = privateKeyToAccount(env[key])
  const wallet = createWalletClient({ account, transport: http(env.MONAD_RPC_URL) })
  const directory = resolve('.sidequest/operations')
  mkdirSync(directory, { recursive: true, mode: 0o700 })
  const path = resolve(directory, `${id}.json`)
  const save = operation => writeFileSync(path, json(operation), { mode: 0o600 })
  let operation
  if (existsSync(path)) {
    operation = JSON.parse(readFileSync(path, 'utf8'))
    if (operation.from !== account.address || operation.to !== to || operation.data !== data || operation.value !== value.toString() || operation.gas !== gas.toString()) throw new Error('operation-input-drift')
  } else {
    const nonce = await client.getTransactionCount({ address: account.address, blockTag: 'pending' })
    if (nonce !== await client.getTransactionCount({ address: account.address })) throw new Error('unreconciled-pending-nonce')
    const maxFeePerGas = (await client.getGasPrice()) * 110n / 100n
    const balance = await client.getBalance({ address: account.address })
    // Monad reserves maximum gas independently of value. Retain headroom instead of draining an EOA.
    if (balance <= value + gas * maxFeePerGas * 2n) throw new Error('testnet-reserve-balance-too-low')
    const signed = await account.signTransaction({ chainId: 10143, type: 'eip1559', nonce, to, data, value, gas, maxFeePerGas, maxPriorityFeePerGas: 0n })
    operation = { id, chainId: 10143, from: account.address, to, data, value: value.toString(), gas: gas.toString(), nonce, hash: keccak256(signed), signed, status: 'prepared', preparedAt: new Date().toISOString() }
    save(operation)
  }
  let receipt = await client.getTransactionReceipt({ hash: operation.hash }).catch(() => null)
  if (!receipt) {
    const pending = await client.getTransaction({ hash: operation.hash }).catch(() => null)
    if (!pending) {
      if (await client.getTransactionCount({ address: account.address }) !== operation.nonce) throw new Error('operation-nonce-consumed-without-receipt')
      const hash = await wallet.sendRawTransaction({ serializedTransaction: operation.signed })
      if (hash !== operation.hash) throw new Error('broadcast-hash-mismatch')
      operation.status = 'broadcast'
      save(operation)
    }
    receipt = await client.waitForTransactionReceipt({ hash: operation.hash, confirmations: 12 })
  }
  operation.status = receipt.status
  operation.block = receipt.blockNumber.toString()
  operation.gasUsed = receipt.gasUsed.toString()
  save(operation)
  if (receipt.status !== 'success') throw new Error('operation-reverted-read-receipt-before-new-attempt')
  return { id, hash: operation.hash, block: operation.block, status: operation.status, receipt }
}
