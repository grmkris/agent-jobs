import * as sdk from "@agent-jobs/sdk";
import type { Address, Hex } from "viem";
import type { TxRequest } from "../api.ts";

export interface RecoveryPlan {
  id: string;
  operator: Address;
  agent: Address;
  call: { target: Address; value: string; callData: Hex };
  grant: string | null;
  description: string;
  action: string;
  token: string;
  units: string;
  tx?: TxRequest;
}

/** Read the deadline from the frozen permission bytes, not an editable display field. */
export function recoveryExpiry(plan: RecoveryPlan, timestampEnforcer: Address): number | null {
  if (plan.grant === null) return null;
  const caveats = sdk.parseDelegation(plan.grant).caveats.filter(caveat => caveat.enforcer.toLowerCase() === timestampEnforcer.toLowerCase());
  if (caveats.length !== 1 || !/^0x[0-9a-f]{64}$/i.test(caveats[0]!.terms)) throw new Error("Invalid recovery expiry");
  const expiry = Number(BigInt(`0x${caveats[0]!.terms.slice(34)}`));
  if (!Number.isSafeInteger(expiry) || expiry <= 0) throw new Error("Invalid recovery expiry");
  return expiry;
}

export function recoveryReplacementAllowed(expiry: number | null, chainTimestamp: number, safeToRestart: boolean): boolean {
  return expiry !== null && chainTimestamp >= expiry && safeToRestart;
}
