import { expect, test } from "vitest";
import * as sdk from "@agent-jobs/sdk";
import { recoveryExpiry, recoveryReplacementAllowed, type RecoveryPlan } from "./recovery-plan.ts";

const deployment = sdk.deployment("monad-testnet");

const plan: RecoveryPlan = {
  id: "old",
  operator: "0x1111111111111111111111111111111111111111",
  agent: "0x2222222222222222222222222222222222222222",
  call: { target: "0x3333333333333333333333333333333333333333", value: "0", callData: "0x" },
  grant: sdk.delegationJson(sdk.recoveryGrant(deployment, "0x2222222222222222222222222222222222222222", "0x1111111111111111111111111111111111111111", { target: "0x1111111111111111111111111111111111111111", value: 0n, callData: "0x" }, 1n, 400)),
  description: "Cancel unstake",
  action: "cancel",
  token: "0x4444444444444444444444444444444444444444",
  units: "",
};

test("recovery replacement waits for chain expiry and a reconciled wallet journal", () => {
  const expiry = recoveryExpiry(plan, deployment.delegation.enforcers.timestamp);
  expect(expiry).toBe(1000);
  expect(recoveryReplacementAllowed(expiry, 999, true)).toBe(false);
  expect(recoveryReplacementAllowed(expiry, 1000, false)).toBe(false);
  expect(recoveryReplacementAllowed(expiry, 1000, true)).toBe(true);
});
