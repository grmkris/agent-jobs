import * as sdk from "@agent-jobs/sdk";
import { Link } from "@tanstack/react-router";
import { useState } from "react";
import { type Address, encodeFunctionData, erc20Abi, formatUnits, parseSignature } from "viem";
import { useSignTypedData } from "wagmi";
import type { ManagedAgent } from "../api.ts";
import { chain, deployment } from "../wallet.ts";
import { hireling } from "../hireling.ts";
import { factoryAmount } from "../stake.ts";
import { stakeContext } from "../stake-context.ts";
import { friendlyError } from "../txErrors.ts";
import { vaultOperationGuards } from "../vault-proof.ts";
import { Button, ErrorText, Input, Section } from "./ui.tsx";
import { TxSteps } from "./TxSteps.tsx";
import { initializeTxJournal } from "./txJournal.ts";
import { useOperatorBalances } from "../operator-balances.ts";
import { useBacking } from "../delegation-query.ts";
import { factoryValue } from "./DelegationPositions.tsx";
import { OperatorBalances } from "./OperatorBalances.tsx";
import {
  type VaultIntent,
  clearOwnedIntent,
  readVaultIntent,
  vaultIntentKey,
  withVaultIntentLock,
} from "../vault-lock.ts";

export function AgentStake({ agent, operator }: { agent: ManagedAgent; operator: string }) {
  const balances = useOperatorBalances(operator as Address);
  const backing = useBacking(agent.address === null ? undefined : agent.address as Address);
  const { signTypedDataAsync } = useSignTypedData();
  const key = vaultIntentKey(chain.id, hireling?.vault ?? "unavailable", operator);
  const [initial] = useState(() => {
    try {
      return {
        intent: readVaultIntent(localStorage, key),
        error: null,
      };
    } catch {
      return {
        intent: null,
        error:
          "The saved delegation is unreadable. Restore its journal before preparing another action.",
      };
    }
  });
  const [amount, setAmount] = useState("");
  const [intent, setIntent] = useState(initial.intent);
  const [error, setError] = useState<string | null>(initial.error);
  const [busy, setBusy] = useState(false);

  async function prepare() {
    setError(null);
    setBusy(true);
    try {
      await withVaultIntentLock(navigator.locks, key, async () => {
        if (readVaultIntent(localStorage, key) !== null)
          throw new Error(
            "Another tab has an unfinished position action. Open Stake & delegate to reconcile it first.",
          );
        const units = factoryAmount(amount);
        if (agent.address === null || agent.agent_id === null || hireling === null || units === null) {
          throw new Error("Enter a positive FACTORY amount");
        }
        const vault = hireling.vault;
        const ctx = stakeContext();
        const [balance, wallet] = await Promise.all([
          ctx.publicClient.readContract({ address: hireling.factory, abi: sdk.factoryV2Abi, functionName: "balanceOf", args: [operator as Address] }),
          ctx.publicClient.readContract({ address: deployment.identity, abi: sdk.identityAbi, functionName: "getAgentWallet", args: [BigInt(agent.agent_id)] }),
        ]);
        if (units > balance)
          throw new Error("That is more FACTORY than your wallet holds");
        if (wallet.toLowerCase() !== agent.address.toLowerCase())
          throw new Error("This agent changed its wallet. Refresh before delegating.");
        const target = agent.address as Address;
        const approval = {
          chainId: chain.id,
          description: `Approve ${amount} FACTORY for the vault`,
          to: hireling.factory,
          value: "0",
          data: encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [vault, units] }),
        };
        const delegation = {
          chainId: chain.id,
          description: `Delegate ${amount} FACTORY to ${agent.name}`,
          to: vault,
          value: "0",
          data: encodeFunctionData({ abi: sdk.stakeVaultAbi, functionName: "delegate", args: [target, units] }),
        };
        const delegatedTo = await sdk.delegationOf(ctx.publicClient, operator as Address);
        let txs: VaultIntent["txs"];
        if (delegatedTo?.toLowerCase() === deployment.delegation.delegator.toLowerCase()) {
          txs = [{ chainId: chain.id, description: `Delegate ${amount} FACTORY to ${agent.name}`, to: operator as Address, value: "0", data: sdk.batchCalldata([approval, delegation]) }];
        } else {
          const permit = await sdk.delegatePermit(ctx, operator as Address, units, BigInt(Math.floor(Date.now() / 1000) + 3600));
          const signature = await signTypedDataAsync(permit);
          const { r, s, v, yParity } = parseSignature(signature);
          txs = [{
            chainId: chain.id,
            description: `Delegate ${amount} FACTORY to ${agent.name}`,
            to: vault,
            value: "0",
            data: encodeFunctionData({ abi: sdk.stakeVaultAbi, functionName: "delegateWithPermit", args: [target, units, permit.message.deadline, Number(v ?? BigInt(yParity + 27)), r, s] }),
          }];
        }
        const next: VaultIntent = {
          id: crypto.randomUUID(),
          kind: "delegate",
          account: agent.address as Address,
          txs,
        };
        initializeTxJournal(localStorage, `delegation:${next.id}`, next.txs);
        const bytes = JSON.stringify(next);
        localStorage.setItem(key, bytes);
        if (localStorage.getItem(key) !== bytes)
          throw new Error("Delegation intent could not be saved; nothing may start");
        setIntent(next);
      });
    } catch (failure) {
      setError(friendlyError(failure));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Section
      title="Delegate backing to this agent"
      note="Your operator wallet delegates in one transaction and owns the position. The agent uses the backing for bonds and its fee tier. A slash reduces every backing position by the same share."
    >
      <OperatorBalances operator={operator as Address} />
      {backing.isError || backing.data === undefined ? (
        <p className="text-sm text-label-2">Agent backing is unavailable.</p>
      ) : (
        <dl aria-label="This agent’s backing" className="flex flex-wrap gap-x-5 gap-y-2 text-sm tabular">
          <div><dt className="text-label-2">Total backing</dt><dd>{factoryValue(backing.data.backing.assets)}</dd></div>
          <div><dt className="text-label-2">Active backing</dt><dd>{factoryValue(backing.data.backing.active)}</dd></div>
          <div><dt className="text-label-2">Reserved for bonds</dt><dd>{factoryValue(backing.data.backing.reserved)}</dd></div>
        </dl>
      )}
      {intent === null ? (
        <div className="flex flex-wrap gap-2">
          <Input
            value={amount}
            onChange={(event) => setAmount(event.target.value)}
            placeholder="FACTORY amount"
            aria-label="FACTORY to delegate to agent"
            inputMode="decimal"
          />
          <Button variant="plain" disabled={balances.factory === undefined || balances.factory === 0n || busy} onClick={() => setAmount(formatUnits(balances.factory!, 18))}>
            Max
          </Button>
          <Button disabled={initial.error !== null} busy={busy} onClick={() => void prepare()}>
            Review delegation
          </Button>
        </div>
      ) : intent.account.toLowerCase() !== agent.address?.toLowerCase() ||
        intent.kind !== "delegate" ? (
        <Link to="/stake" className="min-h-11 content-center font-semibold text-tint">
          Open Stake &amp; delegate to reconcile your saved position action
        </Link>
      ) : (
        <TxSteps
          key={intent.id}
          taskId={`delegation:${intent.id}`}
          txs={intent.txs}
          owner={operator}
          reportToBoard={false}
          allowBatch={false}
          allowSponsorship={false}
          retainRecord
          requireJournal
          verifyReceipt
          {...vaultOperationGuards(stakeContext(), localStorage, key, intent, operator as Address)}
          onDone={() => {
            void withVaultIntentLock(navigator.locks, key, async () => {
              if (!clearOwnedIntent(localStorage, key, intent.id))
                throw new Error(
                  "A newer position action is saved in another tab; keep it for reconciliation.",
                );
              setIntent(null);
              setAmount("");
            }).catch(() => {
              setError(
                "The confirmed delegation could not be cleared from storage. Restore storage to reconcile it.",
              );
            });
          }}
        />
      )}
      {error !== null && <ErrorText>{error}</ErrorText>}
    </Section>
  );
}
