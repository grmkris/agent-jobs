import { readFileSync, writeFileSync } from 'node:fs'
import { concatHex, createPublicClient, decodeEventLog, encodeAbiParameters, encodeFunctionData, getAddress, http, parseAbi, parseAbiParameters, parseEther, zeroAddress } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { loadEnv, testnetOperation } from './transaction.mjs'

const env = loadEnv()
const infra = JSON.parse(readFileSync('infra/dev.json', 'utf8'))
const client = createPublicClient({ transport: http(env.MONAD_TESTNET_RPC_URL) })
const address = role => privateKeyToAccount(env[`SIDEQUEST_DEV_${role}_PRIVATE_KEY`]).address
const safeAbi = parseAbi(['function setup(address[],uint256,address,bytes,address,address,uint256,address)', 'function getOwners() view returns (address[])', 'function getThreshold() view returns (uint256)', 'function VERSION() view returns (string)'])
const factoryAbi = parseAbi(['function createProxyWithNonce(address,bytes,uint256) returns (address)', 'event ProxyCreation(address indexed proxy,address singleton)'])

try {
  if (await client.getChainId() !== 10143) throw new Error('testnet-chain-mismatch')
  if (process.argv[2] === 'fund') {
    // Leave the old Safe owner funded for outstanding-work reconciliation; only native testnet gas moves.
    for (const [role, amount] of [['DEPLOYER', '2.5'], ['RELAY', '0.4']]) {
      const result = await testnetOperation({ id: `fund-${role.toLowerCase()}-20261006`, key: 'SAFE_BACKUP_TESTNET_PRIVATE_KEY', to: address(role), value: parseEther(amount), gas: 30_000n, env })
      console.log(JSON.stringify({ id: result.id, hash: result.hash, block: result.block, status: result.status }))
    }
  } else if (process.argv[2] === 'rewards') {
    const artifact = JSON.parse(readFileSync('contracts/out/MockPaymentToken.sol/MockPaymentToken.json', 'utf8'))
    const tokens = []
    for (const [name, symbol] of [['Sidequest USD (testnet)', 'mUSD'], ['Sidequest EUR (testnet)', 'mEUR']]) {
      const data = concatHex([artifact.bytecode.object, encodeAbiParameters(parseAbiParameters('string,string'), [name, symbol])])
      const result = await testnetOperation({ id: `reward-${symbol.toLowerCase()}-20261006`, key: 'SIDEQUEST_DEV_DEPLOYER_PRIVATE_KEY', data, gas: 1_000_000n, env })
      const token = result.receipt.contractAddress
      if (!token || await client.readContract({ address: token, abi: parseAbi(['function symbol() view returns (string)']), functionName: 'symbol' }) !== symbol) throw new Error('reward-readback-mismatch')
      tokens.push(token)
      console.log(JSON.stringify({ symbol, token, hash: result.hash, block: result.block }))
    }
    const config = JSON.parse(readFileSync('contracts/config/monad-testnet.json', 'utf8'))
    config.knownTokens = tokens
    config.deployment.rewardTokens = tokens
    writeFileSync('contracts/config/monad-testnet.json', JSON.stringify(config, null, 2) + '\n')
  } else if (process.argv[2] === 'faucet') {
    // The testnet "Get test tokens" faucet: 1,000 SIDE (transferred from its balance) + 1,000 of each payment token
    // (minted) per address per day. Owned by the admin; funded with 10M SIDE from the ecosystem allocation.
    const config = JSON.parse(readFileSync('contracts/config/monad-testnet.json', 'utf8'))
    const side = config.deployment.factory
    const payment = config.deployment.rewardTokens
    const artifact = JSON.parse(readFileSync('contracts/out/TestnetFaucet.sol/TestnetFaucet.json', 'utf8'))
    const data = concatHex([artifact.bytecode.object, encodeAbiParameters(parseAbiParameters('address,address,address[],uint256,uint256'), [address('DEPLOYER'), side, payment, parseEther('1000'), 1_000_000_000n])])
    const deployed = await testnetOperation({ id: 'faucet-deploy-20261006', key: 'SIDEQUEST_DEV_DEPLOYER_PRIVATE_KEY', data, gas: 1_500_000n, env })
    const faucet = deployed.receipt.contractAddress
    const faucetAbi = parseAbi(['function stakeToken() view returns (address)', 'function paymentTokens() view returns (address[])', 'function owner() view returns (address)'])
    const read = functionName => client.readContract({ address: faucet, abi: faucetAbi, functionName })
    if (!faucet || (await read('stakeToken')).toLowerCase() !== side.toLowerCase() || (await read('paymentTokens')).join() !== payment.join() || await read('owner') !== address('DEPLOYER')) throw new Error('faucet-readback-mismatch')
    console.log(JSON.stringify({ faucet, hash: deployed.hash, block: deployed.block }))
    const transfer = encodeFunctionData({ abi: parseAbi(['function transfer(address,uint256) returns (bool)']), functionName: 'transfer', args: [faucet, parseEther('10000000')] })
    const funded = await testnetOperation({ id: 'faucet-fund-20261006', key: 'SIDEQUEST_DEV_CREATOR_PRIVATE_KEY', to: side, data: transfer, gas: 100_000n, env })
    console.log(JSON.stringify({ funded: '10000000 SIDE', hash: funded.hash, block: funded.block }))
    config.deployment.testnetFaucet = getAddress(faucet)
    writeFileSync('contracts/config/monad-testnet.json', JSON.stringify(config, null, 2) + '\n')
  } else if (process.argv[2] === 'swap-helper') {
    // Explore's testnet Buy: Monad testnet has no Uniswap UniversalRouter or V4Quoter, so a small exact-input helper
    // swaps against the seeded SIDE/mUSD v4 pool (script/SeedPool.s.sol). It holds nothing and has no owner.
    const config = JSON.parse(readFileSync('contracts/config/monad-testnet.json', 'utf8'))
    const poolManager = config.liquidity.uniswapV4.poolManager
    const artifact = JSON.parse(readFileSync('contracts/out/V4SwapHelper.sol/V4SwapHelper.json', 'utf8'))
    const data = concatHex([artifact.bytecode.object, encodeAbiParameters(parseAbiParameters('address'), [poolManager])])
    const deployed = await testnetOperation({ id: 'swap-helper-deploy-20261006', key: 'SIDEQUEST_DEV_CREATOR_PRIVATE_KEY', data, gas: 950_000n, env })
    const helper = deployed.receipt.contractAddress
    if (!helper || await client.readContract({ address: helper, abi: parseAbi(['function poolManager() view returns (address)']), functionName: 'poolManager' }) !== poolManager) throw new Error('swap-helper-readback-mismatch')
    console.log(JSON.stringify({ helper, hash: deployed.hash, block: deployed.block }))
    config.liquidity.swapHelper = getAddress(helper)
    writeFileSync('contracts/config/monad-testnet.json', JSON.stringify(config, null, 2) + '\n')
  } else if (process.argv[2] === 'safe') {
    for (const target of Object.values(infra.safeInfrastructure)) {
      if (!await client.getCode({ address: target })) throw new Error('safe-infrastructure-missing')
    }
    const owners = [address('SAFE_OWNER'), address('SAFE_BACKUP')]
    const initialization = encodeFunctionData({ abi: safeAbi, functionName: 'setup', args: [owners, 1n, zeroAddress, '0x', infra.safeInfrastructure.fallbackHandler, zeroAddress, 0n, zeroAddress] })
    const data = encodeFunctionData({ abi: factoryAbi, functionName: 'createProxyWithNonce', args: [infra.safeInfrastructure.singleton, initialization, 2026100601n] })
    const result = await testnetOperation({ id: 'safe-create-20261006', key: 'SIDEQUEST_DEV_DEPLOYER_PRIVATE_KEY', to: infra.safeInfrastructure.factory, data, gas: 500_000n, env })
    const creation = result.receipt.logs.filter(log => log.address.toLowerCase() === infra.safeInfrastructure.factory.toLowerCase()).map(log => { try { return decodeEventLog({ abi: factoryAbi, ...log }) } catch { return null } }).find(event => event?.eventName === 'ProxyCreation')
    if (!creation || creation.args.singleton.toLowerCase() !== infra.safeInfrastructure.singleton.toLowerCase()) throw new Error('safe-creation-receipt-mismatch')
    const safe = creation.args.proxy
    const [actualOwners, threshold, version, singleton] = await Promise.all([
      client.readContract({ address: safe, abi: safeAbi, functionName: 'getOwners' }),
      client.readContract({ address: safe, abi: safeAbi, functionName: 'getThreshold' }),
      client.readContract({ address: safe, abi: safeAbi, functionName: 'VERSION' }),
      client.getStorageAt({ address: safe, slot: '0x0' }),
    ])
    if (JSON.stringify(actualOwners.map(a => a.toLowerCase()).toSorted()) !== JSON.stringify(owners.map(a => a.toLowerCase()).toSorted()) || threshold !== 1n || version !== '1.4.1' || singleton?.slice(-40).toLowerCase() !== infra.safeInfrastructure.singleton.slice(2).toLowerCase()) throw new Error('safe-readback-mismatch')
    const record = { chainId: 10143, safe, owners, threshold: 1, version, hash: result.hash, block: result.block }
    writeFileSync('.sidequest/safe.json', JSON.stringify(record, null, 2) + '\n', { mode: 0o600 })
    console.log(JSON.stringify(record))
  } else throw new Error('use-fund-safe-rewards-faucet-or-swap-helper')
} catch (error) {
  console.error(error instanceof Error && /^[a-z0-9-]+$/.test(error.message) ? error.message : 'testnet-setup-failed-inspect-private-journal')
  process.exitCode = 1
}
