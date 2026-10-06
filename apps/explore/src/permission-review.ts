/**
 * Permissions on demand, reviewed before the operator's wallet signs. The card rebuilds the expected permission
 * locally from the agent's frozen request and the operator's own adjustment; the server's prepared template must equal
 * it exactly, so the server's display text is never signing authority (as with agent grants).
 */
import * as sdk from "@agent-jobs/sdk";
import type { Address, Hex } from "viem";

/** An approval of kind "permission": the agent's validated request, as the board froze it. */
export interface PermissionRequestView {
  terms: string;
  expiry: number;
  adjustable: boolean;
  justification: string | null;
  standing: boolean;
}

export interface PreparedPermission {
  hash: Hex;
  grant: unknown;
  description: { validAfter: number };
}

export function permissionRequest(requestJson: string): PermissionRequestView & { parsed: sdk.PermissionTerms } {
  const request = JSON.parse(requestJson) as PermissionRequestView;
  // One canonical reading of stored terms: the SDK's spec parser, with placeholder parties.
  const parsed = sdk.parsePermissionSpec(
    JSON.stringify({
      kind: "permission",
      delegator: "0x0000000000000000000000000000000000000001",
      agent: "0x0000000000000000000000000000000000000002",
      salt: "0",
      start: 0,
      expiry: 0,
      terms: JSON.parse(request.terms),
    }),
  ).terms;
  return { ...request, parsed };
}

/** The operator's choice applied to the request, by the same rule the board applies: shorter or lower only. */
export function expectedPermission(
  request: PermissionRequestView & { parsed: sdk.PermissionTerms },
  adjust: { expiry?: number; amount?: bigint },
) {
  const adjustment = {
    ...(adjust.expiry === undefined ? {} : { expiry: adjust.expiry }),
    ...(adjust.amount === undefined
      ? {}
      : request.parsed.type === "erc20-token-periodic"
        ? { periodAmount: adjust.amount }
        : { amount: adjust.amount }),
  };
  return sdk.adjustPermission(
    {
      terms: request.parsed,
      expiry: request.expiry,
      adjustable: request.adjustable,
      justification: request.justification,
    },
    adjustment,
  );
}

export function reviewPermission(
  deployment: sdk.Deployment,
  prepared: PreparedPermission,
  expected: { operator: Address; agent: Address; terms: sdk.PermissionTerms; expiry: number; adjusted: boolean },
  now = Math.floor(Date.now() / 1000),
) {
  const grant = sdk.parseDelegation(JSON.stringify(prepared.grant));
  const spec: sdk.PermissionSpec = {
    kind: "permission",
    delegator: expected.operator,
    agent: expected.agent,
    salt: grant.salt,
    start: prepared.description.validAfter,
    expiry: expected.expiry,
    terms: expected.terms,
  };
  sdk.assertGrant({ deployment, stack: deployment.stacks.main! }, spec, grant);
  if (sdk.delegationHash(grant) !== prepared.hash)
    throw new Error("The permission hash does not match the review");
  if (spec.start > now + 60) throw new Error("The permission starts too far in the future");
  if (spec.expiry <= now) throw new Error("This permission expired; the agent must ask again");
  return {
    hash: prepared.hash,
    typedData: sdk.delegationTypedData(deployment, grant),
    description: sdk.describePermission(spec),
    risks: sdk.permissionRisks(deployment, spec, { now, adjusted: expected.adjusted }),
  };
}
