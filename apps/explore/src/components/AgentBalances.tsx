import * as sdk from "@agent-jobs/sdk";
import { useState } from "react";
import { type Address, erc20Abi } from "viem";
import { useReadContracts } from "wagmi";
import type { ManagedAgent } from "../api.ts";
import { agentAction } from "../agent-api.ts";
import { chain, deployment } from "../wallet.ts";
import { amount } from "../format.ts";
import { useTokenList } from "../useTokens.ts";
import { Button, ErrorText, Input, Section } from "./ui.tsx";

export function AgentBalances({
  agent,
  operationKey,
  onConfirmed,
}: {
  agent: ManagedAgent;
  operationKey: string;
  onConfirmed: () => void;
}) {
  const tokens = [...new Set([...deployment.rewardTokens, deployment.factory])];
  useTokenList(tokens);
  const vault = deployment.hireling!.vault;
  const reads = useReadContracts({
    contracts: [
      ...tokens.map(
        (token) =>
          ({
            address: token,
            abi: erc20Abi,
            functionName: "balanceOf",
            args: [agent.address as Address],
            chainId: chain.id,
          }) as const,
      ),
      {
        address: vault,
        abi: sdk.stakeVaultAbi,
        functionName: "stakeOf",
        args: [agent.address as Address],
        chainId: chain.id,
      },
      {
        address: vault,
        abi: sdk.stakeVaultAbi,
        functionName: "unstakeOf",
        args: [agent.address as Address],
        chainId: chain.id,
      },
    ],
    query: { refetchInterval: 15000 },
  });
  const [unstake, setUnstake] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const journalKey = `hireling.agent-action:${agent.id}`;
  const [pending, setPending] = useState<{
    tool: string;
    args: Record<string, unknown>;
    key: string;
  } | null>(() => {
    try {
      return JSON.parse(localStorage.getItem(journalKey) ?? "null") as {
        tool: string;
        args: Record<string, unknown>;
        key: string;
      } | null;
    } catch {
      return null;
    }
  });
  async function execute(tool: string, args: Record<string, unknown>) {
    setBusy(true);
    setError(null);
    try {
      if (
        pending !== null &&
        (pending.tool !== tool || JSON.stringify(pending.args) !== JSON.stringify(args))
      )
        throw new Error("Reconcile the saved action before starting another");
      const intent = pending ?? { tool, args, key: operationKey };
      localStorage.setItem(journalKey, JSON.stringify(intent));
      if (localStorage.getItem(journalKey) !== JSON.stringify(intent))
        throw new Error("Action journal is not durable; nothing may start");
      setPending(intent);
      const result = await agentAction<{ status: string; operationId: string }>(
        agent.id,
        "execute",
        { tool, args, operationKey: intent.key },
      );
      if (result.status === "confirmed") {
        localStorage.removeItem(journalKey);
        setPending(null);
        onConfirmed();
        await reads.refetch();
      } else if (result.status === "approval") {
        localStorage.removeItem(journalKey);
        setPending(null);
        onConfirmed();
        setError("Exact unstake approval is waiting in Approvals.");
      } else
        setError(
          `Operation ${result.operationId} is ${result.status}. Retry the same action to reconcile.`,
        );
    } catch (failure) {
      setError(
        failure instanceof Error
          ? failure.message
          : "The action is unavailable; keep the original operation key",
      );
    } finally {
      setBusy(false);
    }
  }
  const unstaking = reads.data?.[tokens.length + 1];
  const cooldown =
    unstaking?.status === "success" ? (unstaking.result as readonly [bigint, number]) : undefined;
  return (
    <Section
      title="Agent earnings and stake"
      note="Balances and cooldown are read from Monad. Sweeps are pinned to your operator wallet."
    >
      {tokens.map((token, index) => {
        const balance = reads.data?.[index];
        return (
          <div
            key={token}
            className="flex flex-wrap items-center justify-between gap-3 border-b border-sep py-2"
          >
            <span>
              {balance?.status === "success"
                ? amount(String(balance.result), token)
                : "Balance unavailable"}
            </span>
            <Button
              variant="tinted"
              size="sm"
              busy={busy}
              disabled={balance?.status !== "success" || balance.result === 0n}
              onClick={() => void execute("sweep_earnings", { token })}
            >
              Move earnings to my wallet
            </Button>
          </div>
        );
      })}
      <p className="text-sm">
        Stake:{" "}
        {reads.data?.[tokens.length]?.status === "success"
          ? amount(String(reads.data[tokens.length]!.result), deployment.factory)
          : "unavailable"}
      </p>
      {cooldown !== undefined && cooldown[0] > 0n && (
        <p role="alert" className="rounded-xl bg-warn-bg p-3 text-sm text-warn">
          Unstaking {amount(cooldown[0].toString(), deployment.factory)}. Withdraws after{" "}
          {new Date(Number(cooldown[1]) * 1000).toLocaleString()}. Emergency recovery can cancel an
          unstake.
        </p>
      )}
      <div className="flex gap-2">
        <Input
          value={unstake}
          onChange={(event) => setUnstake(event.target.value)}
          placeholder="FACTORY amount"
          aria-label="Amount to request unstaking"
          inputMode="decimal"
        />
        <Button
          variant="gray"
          busy={busy}
          onClick={() => void execute("request_unstake", { amount: unstake })}
        >
          Request operator approval
        </Button>
      </div>
      {cooldown !== undefined && cooldown[0] > 0n && (
        <Button variant="tinted" busy={busy} onClick={() => void execute("withdraw_stake", {})}>
          Withdraw after cooldown
        </Button>
      )}
      {pending !== null && (
        <Button
          variant="tinted"
          busy={busy}
          onClick={() => void execute(pending.tool, pending.args)}
        >
          Reconcile saved action
        </Button>
      )}
      {error !== null && <ErrorText>{error}</ErrorText>}
    </Section>
  );
}
