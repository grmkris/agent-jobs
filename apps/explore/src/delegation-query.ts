/** SDK-backed reads: every position and its backing are valued at the same block. */
import * as sdk from "@agent-jobs/sdk";
import { useQuery } from "@tanstack/react-query";
import type { Address } from "viem";
import { type HirelingContracts, hireling } from "./hireling.ts";
import { stakeContext } from "./stake-context.ts";

export type Backing = Awaited<ReturnType<typeof sdk.getBacking>>;
export type Position = Awaited<ReturnType<typeof sdk.getPosition>>;
export interface BackedPosition {
  position: Position;
  backing: Backing;
}

export async function readDelegations(contracts: HirelingContracts, delegator: Address) {
  const ctx = stakeContext(contracts);
  const blockNumber = await ctx.publicClient.getBlockNumber({ cacheTime: 0 });
  const [ledger, wallet, open, cooldown] = await Promise.all([
    sdk.listDelegations(ctx, delegator, { blockNumber }),
    ctx.publicClient.readContract({
      address: contracts.factory,
      abi: sdk.factoryV2Abi,
      functionName: "balanceOf",
      args: [delegator],
      blockNumber,
    }),
    ctx.publicClient.readContract({
      address: contracts.vault,
      abi: sdk.stakeVaultAbi,
      functionName: "bootstrapped",
      blockNumber,
    }),
    ctx.publicClient.readContract({
      address: contracts.vault,
      abi: sdk.stakeVaultAbi,
      functionName: "UNSTAKE_DELAY",
      blockNumber,
    }),
  ]);
  const positions = await Promise.all(
    ledger.positions.map(async (position): Promise<BackedPosition> => ({
      position,
      backing: await sdk.getBacking(ctx, position.account, { blockNumber }),
    })),
  );
  return {
    positions,
    wallet,
    open,
    cooldown: Number(cooldown),
    blockNumber,
    source: ledger.source,
  };
}

export function useDelegations(contracts: HirelingContracts, delegator: Address) {
  return useQuery({
    queryKey: ["delegations", contracts.vault, delegator.toLowerCase()],
    queryFn: () => readDelegations(contracts, delegator),
    refetchInterval: 15_000,
    retry: false,
  });
}

export function useBacking(account: Address, delegator?: Address) {
  return useQuery({
    queryKey: ["backing", hireling?.vault, account.toLowerCase(), delegator?.toLowerCase()],
    enabled: hireling !== null,
    queryFn: async () => {
      const ctx = stakeContext();
      const blockNumber = await ctx.publicClient.getBlockNumber({ cacheTime: 0 });
      const [backing, position] = await Promise.all([
        sdk.getBacking(ctx, account, { blockNumber }),
        delegator === undefined ? null : sdk.getPosition(ctx, account, delegator, { blockNumber }),
      ]);
      return { backing, position };
    },
    refetchInterval: 15_000,
    retry: false,
  });
}
