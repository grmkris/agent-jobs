import * as sdk from "@agent-jobs/sdk";
import { useState } from "react";
import { type Address, decodeFunctionData } from "viem";
import { useSignTypedData } from "wagmi";
import { agentEndpoint, type ManagedAgent } from "../../api.ts";
import type { AgentApproval } from "../../agent-api.ts";
import { reviewAgentGrant, type PreparedGrant } from "../../agent-grant.ts";
import { AgentGrantReview } from "../AgentGrantReview.tsx";
import { PermissionApproval } from "./PermissionApproval.tsx";
import { Badge, Button, ErrorText, Section } from "../ui.tsx";
import { amount } from "../../format.ts";
import { useTokenList } from "../../useTokens.ts";
import { typedDataArgs } from "../../typed-data.ts";
import { deployment } from "../../wallet.ts";

/** One decision a managed agent waits on; a requested permission has its own card. */
export function Approval(props: Parameters<typeof OperationApproval>[0]) {
  return props.approval.kind === "permission" ? <PermissionApproval {...props} /> : <OperationApproval {...props} />;
}

/**
 * One decision a managed agent waits on: an over-limit hire (the operator signs an exact one-off allowance) or an
 * agent-owned position leaving the vault (exact shares, once). Shown in the agent's Approvals tab and on /approvals.
 */
function OperationApproval({
  approval,
  agent,
  operator,
  refresh,
}: {
  approval: AgentApproval;
  agent: ManagedAgent;
  operator: Address;
  refresh: () => Promise<unknown>;
}) {
  const request = JSON.parse(approval.request_json) as {
    token?: Address;
    amount: string;
    shares?: string;
    publish?: `0x${string}`;
    call?: { to: string; data: `0x${string}` };
  };
  useTokenList(request.token === undefined ? [] : [request.token]);
  const { signTypedDataAsync } = useSignTypedData();
  const [review, setReview] = useState<ReturnType<typeof reviewAgentGrant> | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function run(action: () => Promise<void>) {
    setBusy(true);
    setError(null);
    try {
      await action();
      await refresh();
    } catch (failure) {
      setError(
        failure instanceof Error
          ? failure.message
          : "Decision is unavailable; retry this operation",
      );
    } finally {
      setBusy(false);
    }
  }
  async function prepare() {
    if (request.publish === undefined || request.token === undefined || agent.address === null)
      throw new Error("The exact hire request is incomplete");
    const decoded = decodeFunctionData({ abi: sdk.hirelingHoldingAbi, data: request.publish });
    if (decoded.functionName !== "publish")
      throw new Error("This decision does not name a publish");
    const params = decoded.args[0];
    if (
      params.token.toLowerCase() !== request.token.toLowerCase() ||
      params.reward !== BigInt(request.amount)
    )
      throw new Error("The reward differs from the frozen publish");
    const prepared = await agentEndpoint<PreparedGrant>(
      `/api/approvals/${approval.id}/prepare`,
      "POST",
    );
    setReview(
      reviewAgentGrant(prepared, {
        kind: "allowance-once",
        delegator: operator,
        agent: agent.address as Address,
        token: request.token,
        amount: BigInt(request.amount),
      }),
    );
  }
  async function decide(approved: boolean) {
    if (approved && approval.kind === "unstake") {
      if (
        request.call === undefined ||
        request.call.to.toLowerCase() !== deployment.hireling?.vault.toLowerCase()
      )
        throw new Error("The leaving target is not the vault");
      const decoded = decodeFunctionData({ abi: sdk.stakeVaultAbi, data: request.call.data });
      if (
        decoded.functionName !== "requestUndelegate" ||
        decoded.args[0].toLowerCase() !== agent.address?.toLowerCase() ||
        decoded.args[1] !== BigInt(request.shares!)
      )
        throw new Error("The leaving call differs from the displayed account or shares");
    }
    let signature: string | undefined;
    if (approved && approval.kind === "hire-over-limit") {
      if (review === null) throw new Error("Review the exact one-off allowance first");
      signature = await signTypedDataAsync(typedDataArgs(review.typedData));
    }
    await agentEndpoint(`/api/approvals/${approval.id}/decide`, "POST", {
      approved,
      ...(signature === undefined ? {} : { signature }),
    });
    setReview(null);
  }
  return (
    <Section
      title={`${agent.name} · ${approval.kind === "unstake" ? "Leave agent-owned position" : "Hire approval"}`}
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-xl font-semibold">
          {request.token === undefined
            ? `${amount(request.amount, deployment.factory)} position value`
            : amount(request.amount, request.token)}
        </p>
        <Badge tone={approval.status === "pending" ? "warning" : "neutral"}>
          {approval.status}
        </Badge>
      </div>
      <p className="text-sm leading-relaxed text-label-2">
        {approval.kind === "unstake"
          ? "Approval permits this exact share count once. The vault values those shares at execution time; the cooldown comes from the active network and a slash can change the asset value while they leave."
          : "Your wallet signs one exact token and amount allowance. After verification, the agent signs a one-call approval pinned to Holding and this operation; allowance pull, token approval and publish execute atomically."}
      </p>
      {approval.kind === "unstake" && (
        <p className="break-all text-xs text-label-2">
          Agent-owned shares: {request.shares}. Operator-funded positions are managed from Stake
          &amp; delegate.
        </p>
      )}
      <p className="break-all font-mono text-micro text-label-3">
        Operation {approval.operation_id}
      </p>
      {review !== null && <AgentGrantReview description={review.description} />}
      {approval.status === "pending" && (
        <div className="flex flex-wrap gap-2">
          <Button
            busy={busy}
            onClick={() =>
              void run(
                approval.kind === "hire-over-limit" && review === null
                  ? prepare
                  : () => decide(true),
              )
            }
          >
            {approval.kind === "hire-over-limit"
              ? review === null
                ? "Review exact allowance"
                : "Sign and approve hire"
              : "Approve exact shares"}
          </Button>
          <Button variant="danger" disabled={busy} onClick={() => void run(() => decide(false))}>
            Reject
          </Button>
        </div>
      )}
      {approval.status === "approved" && (
        <Button
          busy={busy}
          onClick={() =>
            void run(async () => {
              await agentEndpoint(`/api/approvals/${approval.id}/retry`, "POST");
            })
          }
        >
          Reconcile and continue approved operation
        </Button>
      )}
      {error !== null && <ErrorText>{error}</ErrorText>}
    </Section>
  );
}
