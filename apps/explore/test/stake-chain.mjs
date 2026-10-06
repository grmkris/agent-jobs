// Browser-only RPC double. The real SDK reads, conversions and ABI decoding run against this transport.
import * as sdk from '@sidequest/sdk';
import { createPublicClient, custom, erc20Abi, decodeFunctionData, toFunctionSelector, parseAbi, parseAbiParameters, decodeAbiParameters, encodeFunctionResult, encodeEventTopics, encodeAbiParameters } from 'viem';
import { chainLatency } from './wagmi.mjs';
import { chain, deployment } from '../src/wallet.ts';

const zero = '0x0000000000000000000000000000000000000000';
const emptyPool = { assets: 0n, reserved: 0n, shares: 0n, queuedShares: 0n, generation: 0n, positions: {} };
export const schedule = { thresholds: [0n, 10n ** 22n, 10n ** 23n, 10n ** 24n], bps: [3000, 1000, 300, 100], treasury: '0x9999999999999999999999999999999999999999' };
const emptyPosition = generation => ({ shares: 0n, queuedShares: 0n, unlockAt: 0, generation });
export function poolOf(account) { return typeof account === 'string' ? window.__stake.pools[account.toLowerCase()] ?? emptyPool : emptyPool; }
export function positionOf(account, delegator) {
  const pool = poolOf(account);
  const position = pool.positions[delegator.toLowerCase()] ?? emptyPosition(pool.generation);
  return position.generation === pool.generation ? position : emptyPosition(pool.generation);
}
export function answer({ functionName, address, args = [] }, historical = false) {
  const s = window.__stake;
  const pool = poolOf(args[0] ?? window.__wallet.address);
  switch (functionName) {
    case 'poolOf': return historical && s.historical?.[args[0].toLowerCase()] !== undefined ? { ...pool, generation: BigInt(s.historical[args[0].toLowerCase()]) } : pool;
    case 'positionOf': return positionOf(args[0], args[1]);
    case 'stakeOf': return pool.shares === 0n ? 0n : (pool.shares - pool.queuedShares) * pool.assets / pool.shares;
    case 'reservedOf': return pool.reserved;
    case 'availableOf': { const active = answer({ functionName: 'stakeOf', args }); return active > pool.reserved ? active - pool.reserved : 0n; }
    case 'convertToShares': return pool.shares === 0n ? args[1] : args[1] * pool.shares / pool.assets;
    case 'UNSTAKE_DELAY': return s.cooldown;
    case 'PROPOSAL_GRACE': return s.grace ?? 1800;
    case 'pendingHolding': return s.proposal === undefined ? [zero, 0] : [s.proposal.holding, s.proposal.eta];
    case 'holdingDenied': return s.denied?.[args[1].toLowerCase()] === true;
    case 'schedule': return schedule;
    case 'balanceOf': return args[0].toLowerCase() === window.__wallet.address.toLowerCase()
      ? address?.toLowerCase() === window.__sidequest.factory.toLowerCase() ? s.wallet : s.reward ?? 25_000_000n
      : 0n;
    case 'symbol': return 'SIDE';
    case 'decimals': return 18;
    case 'nonces': return s.nonce;
    case 'name': return 'Factory';
    case 'bootstrapped': return s.open;
    case 'paused': return false;
    case 'getAgentWallet': return window.__agents.find(agent => agent.agentId === String(args[0]))?.wallet ?? zero;
    case 'ownerOf': return window.__wallet.address;
    case 'nextDripAt': return s.faucetNext ?? 0n;
    // The SIDE/mUSD market at $0.0001 per SIDE (10,000 SIDE per mUSD), less the 0.3% pool fee.
    case 'getSlot0': return [7922816251426433759354395033600000000n, 0, 0, 3000];
    case 'quoteExactInputSingle': return [marketOut(args[0].zeroForOne, args[0].exactAmount), 120_000n];
    case 'allowance': return args.length === 3 ? [s.permit2Amount ?? 0n, s.permit2Expiration ?? 0, 0] : s.marketAllowance ?? 0n;
    case 'stakeAmount': return 1000n * 10n ** 18n;
    case 'paymentAmount': return 1000n * 10n ** 6n;
    case 'tokenURI': return 'data:application/json,' + encodeURIComponent(JSON.stringify({ name: window.__agents.find(agent => agent.agentId === String(args[0]))?.profile.name }));
    default: throw new Error(`Fixture has no read for ${functionName}`);
  }
}
const hash = '0x' + 'ab'.repeat(32);
const dripSelector = toFunctionSelector('function drip(address)');
const executeSelector = toFunctionSelector('function execute(bytes,bytes[],uint256)');
const permit2ApproveSelector = toFunctionSelector('function approve(address,address,uint160,uint48)');
const stateViewAbi = parseAbi(['function getSlot0(bytes32 poolId) view returns (uint160 sqrtPriceX96, int24 tick, uint24 protocolFee, uint24 lpFee)']);
const abis = [sdk.stakeVaultAbi, sdk.factoryV2Abi, sdk.feeScheduleAbi, sdk.identityAbi, sdk.testnetFaucetAbi, sdk.v4QuoterAbi, sdk.permit2Abi, stateViewAbi, erc20Abi];
// mUSD sorts first on testnet: zero-for-one spends mUSD for SIDE at 10,000 SIDE per mUSD, less the 0.3% fee.
const marketOut = (zeroForOne, amountIn) => zeroForOne ? amountIn * 10n ** 16n * 997n / 1000n : amountIn / 10n ** 16n * 997n / 1000n;
const minHopSingle = parseAbiParameters('((address currency0, address currency1, uint24 fee, int24 tickSpacing, address hooks) poolKey, bool zeroForOne, uint128 amountIn, uint128 amountOutMinimum, uint256 minHopPriceX36, bytes hookData)');
function decode(data) {
  for (const abi of abis) {
    try { return { ...decodeFunctionData({ abi, data }), abi }; } catch { /* next ABI */ }
  }
  throw new Error('Unknown fixture calldata');
}
const transport = custom({ request: async ({ method, params }) => {
  await chainLatency();
  const s = window.__stake;
  (s.rpcMethods ??= []).push(method);
  if (s.down) throw new Error('Fixture RPC unavailable');
  if (method === 'eth_blockNumber') return '0x' + (110 + window.__wallet.sends.length).toString(16);
  if (method === 'eth_getCode') return window.__stake.code?.[params[0].toLowerCase()] ?? '0x';
  if (method === 'eth_call') {
    const { abi, functionName, args } = decode(params[0].data);
    if (s.unreadable?.includes(functionName)) throw new Error('Fixture read unavailable');
    const result = answer({ functionName, args, address: params[0].to }, params[1] === '0x64');
    return encodeFunctionResult({ abi, functionName, result });
  }
  if (method === 'eth_getLogs') {
    return Object.keys(s.pools).map((account, index) => {
      const position = s.pools[account].positions[window.__wallet.address.toLowerCase()];
      if (position === undefined || Number(BigInt(params[0].fromBlock)) > 100 || Number(BigInt(params[0].toBlock)) < 100) return null;
      return {
        address: window.__sidequest.vault,
        topics: encodeEventTopics({ abi: sdk.stakeVaultAbi, eventName: 'Delegated', args: { account, delegator: window.__wallet.address, payer: window.__wallet.address } }),
        data: encodeAbiParameters([{ type: 'uint256' }, { type: 'uint256' }], [position.shares, position.shares]),
        blockNumber: '0x64', blockHash: hash, transactionHash: hash, transactionIndex: '0x0', logIndex: '0x' + index.toString(16), removed: false,
      };
    }).filter(Boolean);
  }
  throw new Error(`Unexpected fixture RPC ${method}`);
} }, { retryCount: 0 });
// The wallet imports the wagmi double, which imports this module: defer the client until those exports are initialized.
let publicClient;
export function stakeContext(contracts = window.__sidequest) {
  publicClient ??= createPublicClient({ chain, transport });
  return { publicClient, deployment: { ...deployment, sidequest: { ...deployment.sidequest, ...contracts, block: 100n } }, stack: deployment.stacks.main };
}

export function apply({ data }, logs = []) {
  const s = window.__stake;
  if (data.startsWith('0xe9ae5c53')) {
    const { args } = decodeFunctionData({ abi: sdk.delegatorAbi, data });
    if (args[0] !== sdk.BATCH_DEFAULT_MODE) throw new Error('Fixture refuses non-atomic execution');
    const [calls] = decodeAbiParameters([{ type: 'tuple[]', components: [{ name: 'target', type: 'address' }, { name: 'value', type: 'uint256' }, { name: 'callData', type: 'bytes' }] }], args[1]);
    for (const call of calls) apply({ data: call.callData }, logs);
    return;
  }
  if (data.startsWith(executeSelector)) {
    const { args } = decodeFunctionData({ abi: sdk.universalRouterAbi, data });
    if (args[0] !== '0x10') throw new Error('Fixture router runs V4_SWAP only');
    const [actions, params] = decodeAbiParameters([{ type: 'bytes' }, { type: 'bytes[]' }], args[1][0]);
    if (actions !== '0x060c0f') throw new Error('Fixture router expects SWAP_EXACT_IN_SINGLE, SETTLE_ALL, TAKE_ALL');
    const [{ zeroForOne, amountIn, amountOutMinimum }] = decodeAbiParameters(minHopSingle, params[0]);
    if ((s.permit2Amount ?? 0n) < amountIn) throw new Error('Permit2 allowance too low');
    const out = marketOut(zeroForOne, amountIn);
    if (out < amountOutMinimum) throw new Error('V4TooLittleReceived');
    if (zeroForOne) { s.reward = (s.reward ?? 25_000_000n) - amountIn; s.wallet += out; } else { s.wallet -= amountIn; s.reward = (s.reward ?? 25_000_000n) + out; }
    s.calls.push({ functionName: 'swap', args: [String(zeroForOne), String(amountIn), String(amountOutMinimum)] });
    return;
  }
  if (data.startsWith(permit2ApproveSelector)) {
    const { args } = decodeFunctionData({ abi: sdk.permit2Abi, data });
    s.permit2Amount = args[2]; s.permit2Expiration = args[3];
    (s.permit2Calls ??= []).push({ token: args[0], spender: args[1], amount: String(args[2]) });
    return;
  }
  if (data.startsWith(dripSelector)) {
    const { args } = decodeFunctionData({ abi: sdk.testnetFaucetAbi, data });
    s.calls.push({ functionName: 'drip', args: [args[0]] });
    s.wallet += 1000n * 10n ** 18n;
    s.faucetNext = BigInt(Math.floor(Date.now() / 1000) + 86400);
    return;
  }
  let decoded;
  try { decoded = decodeFunctionData({ abi: sdk.stakeVaultAbi, data }); }
  catch { decoded = decodeFunctionData({ abi: erc20Abi, data }); }
  const { functionName, args } = decoded;
  if (functionName === 'approve') {
    s.approvals = (s.approvals ?? 0) + 1;
    (s.approvalCalls ??= []).push({ spender: args[0], amount: String(args[1]) });
    return;
  }
  s.calls.push({ functionName, args: args.map(arg => typeof arg === 'bigint' ? String(arg) : arg) });
  if (functionName === 'setHoldingDenied') { s.denied = { ...s.denied, [args[0].toLowerCase()]: args[1] }; return; }
  const account = args[0].toLowerCase();
  const owner = window.__wallet.address.toLowerCase();
  const pool = s.pools[account] ??= { ...emptyPool, positions: {} };
  const position = pool.positions[owner] ??= emptyPosition(pool.generation);
  if (functionName === 'delegateWithPermit' || functionName === 'delegate') {
    const shares = pool.shares === 0n ? args[1] : args[1] * pool.shares / pool.assets;
    if (position.generation !== pool.generation) Object.assign(position, emptyPosition(pool.generation));
    s.wallet -= args[1]; s.nonce += 1n; pool.assets += args[1]; pool.shares += shares; position.shares += shares;
    logs.push({
      address: window.__sidequest.vault,
      topics: encodeEventTopics({ abi: sdk.stakeVaultAbi, eventName: 'Delegated', args: { account, delegator: owner, payer: owner } }),
      data: encodeAbiParameters([{ type: 'uint256' }, { type: 'uint256' }], [args[1], shares]),
      removed: false,
    });
  }
  if (functionName === 'requestUndelegate') {
    if (args[1] > position.shares - position.queuedShares) throw new Error('NotOwned');
    position.queuedShares += args[1]; pool.queuedShares += args[1]; position.unlockAt = Math.floor(Date.now() / 1000) + s.cooldown;
  }
  if (functionName === 'cancelUndelegate') { pool.queuedShares -= position.queuedShares; position.queuedShares = 0n; position.unlockAt = 0; }
  if (functionName === 'withdraw') {
    const value = position.queuedShares * pool.assets / pool.shares;
    if (pool.assets - value < pool.reserved) throw new Error('StillBonded');
    s.wallet += value; pool.assets -= value; pool.shares -= position.queuedShares; pool.queuedShares -= position.queuedShares; position.shares -= position.queuedShares; position.queuedShares = 0n; position.unlockAt = 0;
  }
}

// Public index API fixture, computed with the SDK's pure valuation helpers at the fixture checkpoint.
window.__stakingSnapshot = (poolAccount, wallet) => {
  const s = window.__stake;
  const blockNumber = 110n + BigInt(window.__wallet.sends.length);
  const backing = account => ({ account, blockNumber, ...sdk.backingOf(poolOf(account), schedule) });
  const position = (account, delegator) => ({ account, delegator, blockNumber,
    ...sdk.positionIn(poolOf(account), positionOf(account, delegator), BigInt(s.historical?.[account] ?? '0')) });
  const positions = Object.keys(s.pools).filter(key => poolAccount === undefined || poolAccount.toLowerCase() === key).flatMap(key =>
    Object.keys(s.pools[key].positions).filter(delegator => poolAccount !== undefined || wallet === undefined || wallet.toLowerCase() === delegator)
      .map(delegator => ({ ...position(key, delegator), backing: backing(key) })));
  const common = { source: 'index+vault', blockNumber, vault: window.__sidequest.vault, token: window.__sidequest.factory };
  const result = poolAccount === undefined ? { ...common, positions } : { ...common, ...backing(poolAccount),
    delegatorCount: positions.filter(p => p.shares > 0n).length,
    topDelegators: positions.filter(p => p.shares > 0n).toSorted((a, b) => a.value > b.value ? -1 : a.value < b.value ? 1 : 0),
    position: wallet === undefined ? null : position(poolAccount, wallet) };
  return JSON.parse(JSON.stringify(result, (_key, value) => typeof value === 'bigint' ? String(value) : value));
};
