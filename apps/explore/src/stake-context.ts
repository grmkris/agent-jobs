/** The deployed staking context shared by Explore's SDK reads and transaction preparation. */
import type { Ctx } from "@agent-jobs/sdk";
import { createPublicClient, http } from "viem";
import { type HirelingContracts, hireling } from "./hireling.ts";
import { chain, deployment } from "./wallet.ts";

const publicClient = createPublicClient({ chain, transport: http() });

export function stakeContext(contracts: HirelingContracts = hireling): Ctx {
  return { publicClient, deployment: { ...deployment, hireling: { ...deployment.hireling, ...contracts } }, stack: deployment.stacks.main };
}
