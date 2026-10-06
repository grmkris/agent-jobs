import type { Address } from "viem";
import type { TxRequest } from "./api.ts";
import { type StepLocks, withWalletStepLock } from "./components/txOperation.ts";

export interface VaultIntent {
  id: string;
  kind: "delegate" | "leave" | "cancel" | "withdraw" | "veto";
  account: Address;
  txs: TxRequest[];
}

type IntentStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;
export interface VaultIntentCheckpoint {
  /** undefined means a legacy browser has no checkpoint; null is a committed clear. */
  read(key: string): Promise<string | null | undefined>;
  write(key: string, value: string | null): Promise<void>;
}
const INTENT_DB = "hireling-vault-intents";
const INTENT_STORE = "pointers";

function intentDb(): Promise<IDBDatabase> {
  if (typeof indexedDB === "undefined")
    return Promise.reject(new Error("This browser cannot durably coordinate vault actions."));
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(INTENT_DB, 1);
    request.addEventListener("upgradeneeded", () => request.result.createObjectStore(INTENT_STORE));
    request.addEventListener("success", () => resolve(request.result));
    request.addEventListener("error", () => reject(request.error ?? new Error("vault intent database unavailable")));
    request.addEventListener("blocked", () => reject(new Error("Vault action coordination is unavailable. Close other Hireling tabs and retry.")));
  });
}

function intentDbRead(key: string): Promise<string | null | undefined> {
  return intentDb().then((db) => new Promise((resolve, reject) => {
    const transaction = db.transaction(INTENT_STORE, "readonly");
    const request = transaction.objectStore(INTENT_STORE).get(key);
    transaction.addEventListener("complete", () => {
      db.close();
      const value: unknown = request.result;
      if (value !== undefined && value !== null && typeof value !== "string") reject(new Error("Vault action checkpoint is unreadable. Reconcile before continuing."));
      else resolve(value);
    });
    transaction.addEventListener("abort", () => { db.close(); reject(transaction.error ?? new Error("vault intent read aborted")); });
  }));
}

function intentDbWrite(key: string, value: string | null): Promise<void> {
  return intentDb().then((db) => new Promise((resolve, reject) => {
    const transaction = db.transaction(INTENT_STORE, "readwrite");
    transaction.objectStore(INTENT_STORE).put(value, key);
    transaction.addEventListener("complete", () => { db.close(); resolve(); });
    transaction.addEventListener("abort", () => { db.close(); reject(transaction.error ?? new Error("vault intent write aborted")); });
  }));
}

export const browserVaultIntentCheckpoint: VaultIntentCheckpoint = { read: intentDbRead, write: intentDbWrite };

export class InterruptedVaultPreparation extends Error {
  constructor(readonly id: string, options?: ErrorOptions) {
    super("A permit preparation is unfinished. Discard it before preparing another position action.", options);
  }
}

function preparationId(raw: string | null | undefined): string | null {
  if (raw == null) return null;
  const value = JSON.parse(raw) as { preparing?: unknown; id?: unknown } | null;
  return value?.preparing === true && typeof value.id === "string" ? value.id : null;
}

/** Caller holds the vault lock. Reserve durably before opening the permit prompt. */
export async function withVaultPermitPreparation<T>(key: string, sign: () => Promise<T>, save: (signature: T) => Promise<void>, checkpoint = browserVaultIntentCheckpoint): Promise<void> {
  const id = crypto.randomUUID();
  await checkpoint.write(key, JSON.stringify({ preparing: true, id }));
  let signature: T;
  try {
    signature = await sign();
  } catch (failure) {
    try { await checkpoint.write(key, null); }
    catch (saveFailure) { throw new InterruptedVaultPreparation(id, { cause: saveFailure }); }
    throw failure;
  }
  try { await save(signature); }
  catch (failure) { throw new InterruptedVaultPreparation(id, { cause: failure }); }
}

/** Caller holds the vault lock. A reservation has never exposed a sendable local pointer. */
export async function discardVaultPreparation(storage: Pick<Storage, "getItem">, key: string, id: string, checkpoint = browserVaultIntentCheckpoint): Promise<boolean> {
  if (preparationId(await checkpoint.read(key)) !== id || storage.getItem(key) !== null) return false;
  await checkpoint.write(key, null);
  return true;
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

/** Read the cross-renderer checkpoint before relying on a localStorage reread. */
export async function readVaultIntentDurable(storage: Pick<Storage, "getItem">, key: string, checkpoint = browserVaultIntentCheckpoint): Promise<VaultIntent | null> {
  const durable = await checkpoint.read(key);
  const preparing = preparationId(durable);
  if (preparing !== null) throw new InterruptedVaultPreparation(preparing);
  const raw = storage.getItem(key);
  const local = readVaultIntent(storage, key);
  if (durable === undefined) return local; // Preserve pre-checkpoint recovery intents.
  if (raw !== null && raw !== durable)
    throw new Error("This position action changed in another tab. Reload to reconcile the saved action.");
  return readVaultIntent({ getItem: () => durable }, key);
}

/** Commit the cross-renderer pointer before exposing it to the local recovery UI. */
export async function writeVaultIntent(storage: IntentStorage, key: string, intent: VaultIntent, checkpoint = browserVaultIntentCheckpoint): Promise<void> {
  const json = JSON.stringify(intent);
  await checkpoint.write(key, json);
  storage.setItem(key, json);
  if (storage.getItem(key) !== json) throw new Error("The operation could not be saved. Nothing may be sent.");
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

/** Delete only the same intent from both recovery stores. */
export async function clearOwnedIntentDurable(storage: IntentStorage, key: string, id: string, checkpoint = browserVaultIntentCheckpoint): Promise<boolean> {
  const durable = await checkpoint.read(key);
  if (durable === null) {
    const local = readVaultIntent(storage, key);
    if (local !== null && local.id !== id) return false;
    return local === null || clearOwnedIntent(storage, key, id);
  }
  if (durable !== undefined && readVaultIntent({ getItem: () => durable }, key)?.id !== id) return false;
  const local = readVaultIntent(storage, key);
  if (local !== null && local.id !== id) return false;
  if (durable === undefined && local === null) return false;
  // A committed tombstone prevents a stale renderer from resurrecting the intent.
  await checkpoint.write(key, null);
  return local === null || clearOwnedIntent(storage, key, id);
}
