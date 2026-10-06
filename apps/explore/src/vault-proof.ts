/** One proof policy for fresh and resumed vault actions on either delegation screen. */
import * as sdk from "@sidequest/sdk";
import { type Address, type TransactionReceipt, decodeAbiParameters, decodeEventLog, decodeFunctionData, encodeEventTopics } from "viem";
import type { WalletStep } from "./components/txOperation.ts";
import { type VaultIntent, type VaultIntentCheckpoint, browserVaultIntentCheckpoint, readVaultIntentDurable } from "./vault-lock.ts";

const executionsAbi = [{ type: "tuple[]", components: [
  { name: "target", type: "address" }, { name: "value", type: "uint256" }, { name: "callData", type: "bytes" },
] }] as const;
const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
const delegatedTopic = encodeEventTopics({ abi: sdk.stakeVaultAbi, eventName: "Delegated" })[0]!;
const invalid = () => new Error("The saved backing does not match this vault and account. Reconcile it before continuing.");

function delegationAmounts(txs: readonly WalletStep[], vault: Address, owner: Address, account: Address): bigint[] {
  return txs.flatMap(tx => {
    if (same(tx.to, owner)) {
      const batch = decodeFunctionData({ abi: sdk.delegatorAbi, data: tx.data });
      if (batch.args[0] !== sdk.BATCH_DEFAULT_MODE || tx.value !== "0") throw invalid();
      const [calls] = decodeAbiParameters(executionsAbi, batch.args[1]);
      if (calls.some(call => same(call.target, owner))) throw invalid();
      return delegationAmounts(calls.map(call => ({ ...tx, to: call.target, data: call.callData, value: String(call.value) })), vault, owner, account);
    }
    if (!same(tx.to, vault)) return [];
    const decoded = decodeFunctionData({ abi: sdk.stakeVaultAbi, data: tx.data });
    if ((decoded.functionName !== "delegate" && decoded.functionName !== "delegateWithPermit") ||
        !same(decoded.args[0], account) || decoded.args[1] <= 0n || tx.value !== "0") throw invalid();
    return [decoded.args[1]];
  });
}

export function vaultOperationGuards(ctx: sdk.Ctx, storage: Pick<Storage, "getItem">, key: string, intent: VaultIntent, owner: Address, checkpoint: VaultIntentCheckpoint = browserVaultIntentCheckpoint) {
  const vault = ctx.deployment.sidequest!.vault;
  return {
    durableJournal: true,
    sendGuard: async (): Promise<string | null> => {
      if (intent.kind === "delegate") {
        if (delegationAmounts(intent.txs, vault, owner, intent.account).length === 0) throw invalid();
        if (intent.txs.some(tx => same(tx.to, owner)) &&
            !same((await sdk.delegationOf(ctx.publicClient, owner)) ?? "", ctx.deployment.delegation.delegator))
          return "Your wallet's batch permission changed. Reconcile the saved action before continuing.";
      }
      return (await readVaultIntentDurable(storage, key, checkpoint))?.id === intent.id ? null
        : "This position action changed in another tab. Reload to reconcile the saved action.";
    },
    receiptGuard: (receipt: Pick<TransactionReceipt, "logs">, steps: readonly WalletStep[]): string | null => {
      if (intent.kind !== "delegate") return null;
      if (delegationAmounts(intent.txs, vault, owner, intent.account).length === 0) throw invalid();
      const amounts = delegationAmounts(steps, vault, owner, intent.account);
      if (amounts.length === 0) return null; // A retained legacy approval step has no delegation effect yet.
      if (!Array.isArray(receipt.logs)) throw new Error("The backing receipt is unreadable. Reconcile it before retrying.");
      const events = receipt.logs.flatMap(log => {
        if (!same(log.address, vault) || log.topics[0] === undefined || !same(log.topics[0], delegatedTopic)) return [];
        const decoded = decodeEventLog({ abi: sdk.stakeVaultAbi, data: log.data, topics: log.topics, strict: true });
        if (decoded.eventName !== "Delegated") return [];
        if (log.removed) throw new Error("The backing receipt was removed from the chain. Reconcile it before retrying.");
        return [decoded.args];
      });
      if (events.length === 0)
        return "Not backed: the receipt has no exact Delegated event. Your saved action is kept; you can try again.";
      if (events.length !== amounts.length || amounts.some(assets => events.filter(event =>
        same(event.account, intent.account) && same(event.delegator, owner) && same(event.payer, owner) && event.assets === assets && event.shares > 0n,
      ).length !== 1))
        throw new Error("The receipt contains a different backing action. Reconcile it before retrying.");
      return null;
    },
  };
}
