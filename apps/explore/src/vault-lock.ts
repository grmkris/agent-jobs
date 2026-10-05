import type { Address } from "viem";
import type { TxRequest } from "./api.ts";
import { type StepLocks, withWalletStepLock } from "./components/txOperation.ts";

export interface VaultIntent {
  id: string;
  kind: "delegate" | "leave" | "cancel" | "withdraw" | "veto";
  account: Address;
  txs: TxRequest[];
}

/** Both delegation screens share one recovery pointer per vault and delegator. */
export const vaultIntentKey = (chainId: number, vault: string, delegator: string) =>
  `hireling.delegation-op:${chainId}:${vault.toLowerCase()}:${delegator.toLowerCase()}`;

export function readVaultIntent(
  storage: Pick<Storage, "getItem">,
  key: string,
): VaultIntent | null {
  const raw = storage.getItem(key);
  if (raw === null) return null;
  const intent = JSON.parse(raw) as VaultIntent;
  if (
    !intent ||
    typeof intent.id !== "string" ||
    typeof intent.account !== "string" ||
    !Array.isArray(intent.txs) ||
    intent.txs.length === 0
  )
    throw new Error(
      "The saved position action is unreadable. Reconcile it before starting another.",
    );
  return intent;
}

/** Serialize all backed accounts too: they share the delegator's recovery pointer. */
export function withVaultIntentLock<T>(
  locks: StepLocks | undefined,
  key: string,
  work: () => Promise<T>,
): Promise<T> {
  return withWalletStepLock(locks, `vault:${key}`, work);
}

/** Do not let an older tab delete a newer operation pointer. */
export function clearOwnedIntent(
  storage: Pick<Storage, "getItem" | "removeItem">,
  key: string,
  id: string,
): boolean {
  const raw = storage.getItem(key);
  if (raw === null) return false;
  try {
    if ((JSON.parse(raw) as { id?: unknown }).id !== id) return false;
  } catch {
    return false;
  }
  storage.removeItem(key);
  return storage.getItem(key) === null;
}
