import * as sdk from "@agent-jobs/sdk";
import { Link } from "@tanstack/react-router";
import { useState } from "react";
import { type Address, encodeFunctionData, erc20Abi, formatUnits } from "viem";
import type { ManagedAgent } from "../api.ts";
import { chain } from "../wallet.ts";
import { hireling } from "../hireling.ts";
import { factoryAmount } from "../stake.ts";
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
        if (agent.address === null || hireling === null || units === null) {
          throw new Error("Enter a positive FACTORY amount");
        }
        const vault = hireling.vault;
        const next: VaultIntent = {
          id: crypto.randomUUID(),
          kind: "delegate",
          account: agent.address as Address,
          txs: [
            {
              chainId: chain.id,
              description: `Approve ${amount} FACTORY for the vault`,
              to: hireling.factory,
              value: "0",
              data: encodeFunctionData({
                abi: erc20Abi,
                functionName: "approve",
                args: [vault, units],
              }),
            },
            {
              chainId: chain.id,
              description: `Delegate ${amount} FACTORY to ${agent.name}`,
              to: vault,
              value: "0",
              data: encodeFunctionData({
                abi: sdk.stakeVaultAbi,
                functionName: "delegate",
                args: [agent.address as Address, units],
              }),
            },
          ],
        };
        initializeTxJournal(localStorage, `delegation:${next.id}`, next.txs);
        const bytes = JSON.stringify(next);
        localStorage.setItem(key, bytes);
        if (localStorage.getItem(key) !== bytes)
          throw new Error("Delegation intent could not be saved; nothing may start");
        setIntent(next);
      });
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "Delegation preparation failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Section
      title="Delegate backing to this agent"
      note="Your operator wallet pays for the approval and delegation, and owns the position. The agent uses the backing for bonds and its fee tier. A slash reduces every backing position by the same share."
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
          allowBatch
          allowSponsorship={false}
          retainRecord
          requireJournal
          verifyReceipt
          sendGuard={() =>
            readVaultIntent(localStorage, key)?.id === intent.id
              ? null
              : "This position action changed in another tab. Reload to reconcile the saved action."
          }
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
