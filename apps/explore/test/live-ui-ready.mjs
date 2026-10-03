import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { parseAbi } from 'viem';

export const sha256 = (body) => createHash('sha256').update(body).digest('hex');
const same = (a, b) => String(a).toLowerCase() === String(b).toLowerCase();

// This operator card is filled only after the coordinator's release/funding announcement. It pins both the exact
// promoted config and hosted asset; a loose environment flag cannot accidentally enable the old deployment.
export function validateReady({ ready, config, configText, archive, address, row }) {
  assert.equal(ready.stack, 'G1b', 'readiness must name G1b');
  for (const field of ['coordinatorReleased', 'gasFixReleased', 'newTokenFunded']) assert.equal(ready[field], true, `${field} is not confirmed`);
  assert.equal(ready.laterSendAuthorized, true, 'later coordinator send authorization is missing');
  assert.match(ready.sendAuthorization, /\S/, 'record the later send authorization reference');
  assert.match(ready.announcement, /\S/, 'record the coordinator announcement reference');
  assert.equal(config.chainId, 10143, 'testnet only');
  assert.equal(config.deployment.main.kind, 'hireling-v1');
  assert.equal(ready.configSha256, sha256(configText), 'promoted config changed');
  assert.match(ready.assetSha256, /^[0-9a-f]{64}$/, 'pin the released Privy asset hash');
  assert.ok(same(ready.wallet, address), 'readiness belongs to another wallet');
  assert.ok(same(ready.factory, config.deployment.hireling.factory), 'new token changed');
  assert.ok(same(ready.holding, config.deployment.main.holding), 'Holding changed');
  assert.equal(ready.block, config.deployment.hireling.block, 'deployment block changed');
  assert.ok(archive.archive && !same(archive.deployment.main.holding, config.deployment.main.holding), 'G1 archive and new Holding are required');
  assert.ok(!same(archive.deployment.hireling.factory, config.deployment.hireling.factory), 'G1b must have new FACTORY v2');
  assert.ok(config.deployment.hireling.clocks, 'promoted clock readback is missing');
  assert.ok(ready.rows.includes(row), 'this row has not been authorized in the session card');
}

export async function verifyReadyChain({ reads, config, address, protocol, rewardToken }) {
  const d = config.deployment;
  const h = d.hireling;
  assert.ok(d.rewardTokens.some((token) => same(token, rewardToken)), 'reward token is not in the promoted config');
  assert.equal(await reads.getChainId(), 10143, 'RPC is not Monad testnet');
  assert.equal(protocol.network, 'monad-testnet');
  assert.equal(protocol.chainId, 10143);
  assert.equal(protocol.paused, false, 'board reports paused or unavailable');
  for (const [actual, expected] of [[protocol.contracts.factory, h.factory], [protocol.contracts.core, d.core],
    [protocol.contracts.stacks.main.holding, d.main.holding], [protocol.contracts.stacks.main.evaluator, d.main.evaluator],
    [protocol.contracts.delegator, config.delegation.delegator], [protocol.contracts.delegationManager, config.delegation.manager]]) {
    assert.ok(same(actual, expected), 'hosted board does not match the promoted stack');
  }
  const getters = [[d.main.holding, 'MIN_REVIEW_WINDOW', 'minReviewWindow'], [d.main.holding, 'MIN_DISPUTE_WINDOW', 'minDisputeWindow'],
    [d.main.holding, 'MIN_ARBITRATION_WINDOW', 'minArbitrationWindow'], [h.vault, 'UNSTAKE_DELAY', 'unstakeDelay'],
    [h.vault, 'HOLDING_DELAY', 'holdingDelay'], [h.feeSchedule, 'DELAY', 'feeDelay'],
    [h.feeSchedule, 'PROPOSAL_GRACE', 'proposalGrace']];
  for (const [target, getter, key] of getters) {
    const value = await reads.readContract({ address: target, abi: parseAbi([`function ${getter}() view returns (uint256)`]), functionName: getter });
    assert.equal(Number(value), h.clocks[key], `${getter} differs from promotion`);
  }
  const erc20 = parseAbi(['function balanceOf(address) view returns (uint256)', 'function symbol() view returns (string)', 'function decimals() view returns (uint8)']);
  const [mon, factory, free, symbol, decimals, reward] = await Promise.all([
    reads.getBalance({ address }),
    reads.readContract({ address: h.factory, abi: erc20, functionName: 'balanceOf', args: [address] }),
    reads.readContract({ address: h.vault, abi: parseAbi(['function availableOf(address) view returns (uint256)']), functionName: 'availableOf', args: [address] }),
    reads.readContract({ address: rewardToken, abi: erc20, functionName: 'symbol' }),
    reads.readContract({ address: rewardToken, abi: erc20, functionName: 'decimals' }),
    reads.readContract({ address: rewardToken, abi: erc20, functionName: 'balanceOf', args: [address] }),
  ]);
  assert.ok(mon > 0n, 'MON funding is missing');
  assert.ok(factory + free >= 10n ** 18n, 'new FACTORY/stake funding is missing');
  assert.equal(symbol, 'mUSD');
  assert.equal(decimals, 6);
  assert.ok(reward >= 1_000_000n, 'mUSD funding is missing');
  return { mon: mon.toString(), factory: factory.toString(), availableStake: free.toString(), reward: reward.toString() };
}
