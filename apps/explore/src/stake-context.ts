/** The deployed staking context shared by Explore's SDK reads and transaction preparation. */
import type { Ctx } from "@agent-jobs/sdk";
import { createPublicClient, http } from "viem";
import { type HirelingContracts, hireling } from "./hireling.ts";
import { chain, deployment } from "./wallet.ts";

const publicClient = createPublicClient({ chain, transport: http() });

export function stakeContext(contracts: HirelingContracts | null = hireling): Ctx {
  const stack = deployment.stacks.main;
  if (contracts === null || deployment.hireling === null || stack?.kind !== "hireling-v1") {
    throw new Error("Delegated staking is unavailable on this network");
  }
  return {
    publicClient,
    deployment: {
      ...deployment,
      hireling: {
        ...deployment.hireling,
        ...contracts,
        safe: contracts.safe ?? deployment.hireling.safe,
      },
    },
    stack,
  };
}
