/** The deployed staking context shared by Explore's SDK reads and transaction preparation. */
import type { Ctx } from "@sidequest/sdk";
import { createPublicClient, http } from "viem";
import { type SidequestContracts, sidequest } from "./sidequest.ts";
import { chain, deployment } from "./wallet.ts";

const publicClient = createPublicClient({ chain, transport: http() });

export function stakeContext(contracts: SidequestContracts = sidequest): Ctx {
  return { publicClient, deployment: { ...deployment, sidequest: { ...deployment.sidequest, ...contracts } }, stack: deployment.stacks.main };
}
