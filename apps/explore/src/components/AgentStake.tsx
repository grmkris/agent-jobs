import * as sdk from "@agent-jobs/sdk";
import { useState } from "react";
import { type Address, encodeFunctionData, erc20Abi, parseUnits } from "viem";
import type { ManagedAgent, TxRequest } from "../api.ts";
import { chain, deployment } from "../wallet.ts";
import { Button, ErrorText, Input, Section } from "./ui.tsx";
import { TxSteps } from "./TxSteps.tsx";

export function AgentStake({ agent, operator }: { agent: ManagedAgent; operator: string }) {
  const [amount, setAmount] = useState("");
  const [txs, setTxs] = useState<TxRequest[] | null>(() => {
    try {
      return JSON.parse(localStorage.getItem(`hireling.agent-stake:${agent.id}`) ?? "null") as
        | TxRequest[]
        | null;
    } catch {
      return null;
    }
  });
  const [error, setError] = useState<string | null>(null);
  function prepare() {
    try {
      if (
        agent.address === null ||
        deployment.hireling === null ||
        !/^\d+(?:\.\d{1,18})?$/.test(amount)
      )
        throw new Error("Enter a positive FACTORY amount");
      const units = parseUnits(amount, 18);
      if (units <= 0n) throw new Error("Enter a positive FACTORY amount");
      const vault = deployment.hireling.vault;
      const calls: TxRequest[] = [
        {
          chainId: chain.id,
          description: `Approve ${amount} FACTORY for the vault`,
          to: deployment.factory,
          value: "0",
          data: encodeFunctionData({
            abi: erc20Abi,
            functionName: "approve",
            args: [vault, units],
          }),
        },
        {
          chainId: chain.id,
          description: `Stake ${amount} FACTORY for ${agent.name}`,
          to: vault,
          value: "0",
          data: encodeFunctionData({
            abi: sdk.stakeVaultAbi,
            functionName: "stakeFor",
            args: [agent.address as Address, units],
          }),
        },
      ];
      localStorage.setItem(`hireling.agent-stake:${agent.id}`, JSON.stringify(calls));
      setTxs(calls);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "Stake preparation failed");
    }
  }
  return (
    <Section
      title="Optional · stake for the agent"
      note="Your operator wallet pays for one approve + stakeFor batch. Stake belongs to the agent, backs its bonds and sets its fee tier. Bond exposure is not capped by the spending allowance."
    >
      {txs === null ? (
        <div className="flex gap-2">
          <Input
            value={amount}
            onChange={(event) => setAmount(event.target.value)}
            placeholder="FACTORY amount"
            aria-label="FACTORY to stake for agent"
            inputMode="decimal"
          />
          <Button onClick={prepare}>Review stake batch</Button>
        </div>
      ) : (
        <TxSteps
          taskId={`agent-stake-${agent.id}`}
          txs={txs}
          owner={operator}
          reportToBoard={false}
          allowBatch
          allowSponsorship={false}
          retainRecord
          verifyReceipt
          onDone={() => {
            localStorage.removeItem(`hireling.agent-stake:${agent.id}`);
            setTxs(null);
            setAmount("");
          }}
        />
      )}
      {error !== null && <ErrorText>{error}</ErrorText>}
    </Section>
  );
}
