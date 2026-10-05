import * as sdk from "@agent-jobs/sdk";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useSearch } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { type Address, encodeFunctionData, isAddress, parseSignature } from "viem";
import { useSignTypedData } from "wagmi";
import { type ManagedAgent, agentEndpoint } from "../api.ts";
import { DelegationForm } from "../components/DelegationForm.tsx";
import {
  DELEGATION_RISK,
  DelegationPositions,
  factoryValue,
} from "../components/DelegationPositions.tsx";
import { HoldingControls } from "../components/HoldingControls.tsx";
import { PrivyLogin } from "../components/Privy.tsx";
import { useToast } from "../components/Sheet.tsx";
import { TxSteps } from "../components/TxSteps.tsx";
import {
  emptyJournal,
  readTxJournal,
  txJournalKey,
  writeTxJournal,
} from "../components/txJournal.ts";
import { withWalletStepLock } from "../components/txOperation.ts";
import {
  Button,
  EmptyState,
  ErrorText,
  LoadingRows,
  PageTitle,
  Section,
} from "../components/ui.tsx";
import { useAuth } from "../components/Wallet.tsx";
import { useDelegations, useIndexedBacking } from "../delegation-query.ts";
import { useDirectory } from "../directory-query.ts";
import { type HirelingContracts, hireling } from "../hireling.ts";
import { stakeContext } from "../stake-context.ts";
import { factoryAmount } from "../stake.ts";
import { friendlyError } from "../txErrors.ts";
import { vaultOperationGuards } from "../vault-proof.ts";
import { chain } from "../wallet.ts";
import {
  type VaultIntent as Operation,
  clearOwnedIntentDurable,
  readVaultIntent,
  readVaultIntentDurable,
  writeVaultIntent,
  vaultIntentKey,
  withVaultIntentLock,
} from "../vault-lock.ts";

export function StakePage() {
  const auth = useAuth();
  const search = useSearch({ strict: false }) as { account?: string };
  const initialAccount =
    search.account !== undefined && isAddress(search.account) ? search.account : undefined;
  if (hireling === null) {
    return (
      <>
        <PageTitle>Stake &amp; delegate</PageTitle>
        <EmptyState title={`Backing is not on ${chain.name} yet`}>
          It opens when the delegated stake vault is deployed on this network.
        </EmptyState>
      </>
    );
  }
  if (auth.address === undefined) {
    return (
      <>
        <PageTitle>Stake &amp; delegate</PageTitle>
        <section className="grid gap-4 rounded-2xl bg-surface p-5">
          <h2 className="font-display text-xl font-bold">Sign in to see your positions</h2>
          <p className="text-label-2">
            Back an agent with FACTORY and keep ownership of your position.
          </p>
          <PrivyLogin />
        </section>
      </>
    );
  }
  return (
    <Stake
      key={auth.address}
      contracts={hireling}
      owner={auth.address}
      initialAccount={initialAccount}
    />
  );
}

function Stake({
  contracts,
  owner,
  initialAccount,
}: {
  contracts: HirelingContracts;
  owner: Address;
  initialAccount: Address | undefined;
}) {
  const toast = useToast();
  const queryClient = useQueryClient();
  const reads = useDelegations(contracts, owner);
  const directory = useDirectory();
  const managed = useQuery({
    queryKey: ["managed-agents", owner.toLowerCase()],
    queryFn: () => agentEndpoint<{ agents: ManagedAgent[] }>("/api/agents"),
    refetchInterval: 30_000,
  });
  const [account, setAccount] = useState<Address>(initialAccount ?? owner);
  const selected = useIndexedBacking(account, owner);
  const [mode, setMode] = useState<"add" | "leave">("add");
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const key = vaultIntentKey(chain.id, contracts.vault, owner);
  const [initial] = useState(() => {
    try {
      return { operation: readVaultIntent(localStorage, key), error: null };
    } catch {
      return {
        operation: null,
        error:
          "Your saved operation is unavailable. Restore browser storage before preparing another transaction.",
      };
    }
  });
  const [operation, setOperation] = useState<Operation | null>(initial.operation);
  const [safeToDismiss, setSafeToDismiss] = useState(initial.operation === null);
  const { signTypedDataAsync } = useSignTypedData();
  useEffect(() => {
    setError(null);
    setText("");
  }, [account, mode]);
  const agents = directory.data?.agents ?? [];
  const mine = new Set(
    (managed.data?.agents ?? []).flatMap((agent) =>
      agent.address === null ? [] : [agent.address.toLowerCase()],
    ),
  );
  const rank = (wallet: string) => (mine.has(wallet) ? 0 : wallet === owner.toLowerCase() ? 1 : 2);
  const positions = (reads.data?.positions ?? []).toSorted((left, right) => {
    const a = left.position.account.toLowerCase();
    const b = right.position.account.toLowerCase();
    return rank(a) - rank(b) || a.localeCompare(b);
  });
  const unavailable =
    reads.isError ||
    selected.isError ||
    reads.data === undefined ||
    selected.data === undefined ||
    initial.error !== null;
  const disabled = unavailable || busy || operation !== null || reads.data?.open !== true;

  async function savePrepared(
    kind: Operation["kind"],
    target: Address,
    description: string,
    data: `0x${string}`,
  ) {
    const next: Operation = {
      id: crypto.randomUUID(),
      kind,
      account: target,
      txs: [{ description, chainId: chain.id, to: contracts.vault, value: "0", data }],
    };
    writeTxJournal(localStorage, txJournalKey(`delegation:${next.id}`, next.txs), emptyJournal());
    await writeVaultIntent(localStorage, key, next);
    setOperation(next);
    setSafeToDismiss(false);
    setText("");
  }

  async function prepare(
    kind: Operation["kind"],
    target: Address,
    description: string,
    data: `0x${string}`,
  ) {
    await withVaultIntentLock(navigator.locks, key, async () => {
      if ((await readVaultIntentDurable(localStorage, key)) !== null)
        throw new Error(
          "Another Stake tab has an unfinished position action. Reconcile it before starting another.",
        );
      await savePrepared(kind, target, description, data);
    });
  }

  async function submit() {
    const amount = factoryAmount(text);
    if (disabled || amount === null) return;
    setBusy(true);
    setError(null);
    try {
      await withVaultIntentLock(navigator.locks, key, async () => {
        if ((await readVaultIntentDurable(localStorage, key)) !== null)
          throw new Error(
            "Another Stake tab has an unfinished position action. Reconcile it before starting another.",
          );
        const ctx = stakeContext(contracts);
        if (mode === "leave") {
          const shares = await sdk.undelegationShares(ctx, account, owner, amount);
          await savePrepared(
            "leave",
            account,
            `Leave ${factoryValue(amount)} behind ${account}`,
            encodeFunctionData({
              abi: sdk.stakeVaultAbi,
              functionName: "requestUndelegate",
              args: [account, shares],
            }),
          );
          return;
        }
        const balance = await ctx.publicClient.readContract({
          address: contracts.factory,
          abi: sdk.factoryV2Abi,
          functionName: "balanceOf",
          args: [owner],
        });
        if (amount > balance) throw new Error("That is more FACTORY than your wallet holds.");
        const agent = agents.find((entry) => entry.wallet.toLowerCase() === account.toLowerCase());
        if (agent !== undefined) {
          const wallet = await ctx.publicClient.readContract({
            address: ctx.deployment.identity,
            abi: sdk.identityAbi,
            functionName: "getAgentWallet",
            args: [BigInt(agent.agentId)],
          });
          if (wallet.toLowerCase() !== account.toLowerCase())
            throw new Error(
              "This agent changed its wallet. Refresh the directory before delegating.",
            );
        }
        const permit = await sdk.delegatePermit(
          ctx,
          owner,
          amount,
          BigInt(Math.floor(Date.now() / 1000) + 3600),
        );
        const signature = await signTypedDataAsync(permit);
        const { r, s, v, yParity } = parseSignature(signature);
        await savePrepared(
          "delegate",
          account,
          `Delegate ${factoryValue(amount)} to ${agent?.profile.name ?? account}`,
          encodeFunctionData({
            abi: sdk.stakeVaultAbi,
            functionName: "delegateWithPermit",
            args: [
              account,
              amount,
              permit.message.deadline,
              Number(v ?? BigInt(yParity + 27)),
              r,
              s,
            ],
          }),
        );
      });
    } catch (failure) {
      setError(friendlyError(failure));
    } finally {
      setBusy(false);
    }
  }

  function direct(kind: "cancel" | "withdraw", target: Address) {
    if (disabled) return;
    void prepare(
      kind,
      target,
      kind === "cancel" ? `Cancel leaving ${target}` : `Withdraw your position from ${target}`,
      kind === "cancel"
        ? encodeFunctionData({
            abi: sdk.stakeVaultAbi,
            functionName: "cancelUndelegate",
            args: [target],
          })
        : encodeFunctionData({ abi: sdk.stakeVaultAbi, functionName: "withdraw", args: [target] }),
    ).catch((failure) => setError(friendlyError(failure)));
  }

  return (
    <>
      <Link to="/me" className="min-h-11 w-fit content-center text-tint">
        ‹ Me
      </Link>
      <PageTitle sub="Back agents with FACTORY. You own each position; the agent uses its backing for bonds.">
        Stake &amp; delegate
      </PageTitle>
      <p className="rounded-xl bg-warn-bg p-4 text-sm leading-relaxed text-warn">
        {DELEGATION_RISK}
      </p>
      {initial.error !== null && <ErrorText>{initial.error}</ErrorText>}
      {(reads.isError || selected.isError) && (
        <div role="status" className="grid gap-2 rounded-xl bg-warn-bg p-4 text-sm text-warn">
          <p>
            {reads.data === undefined
              ? "Your positions could not be read. This does not mean they are gone."
              : "Showing last-known positions. Actions are paused until chain facts refresh."}
          </p>
          <Button
            variant="tinted"
            onClick={() => {
              void reads.refetch();
              void selected.refetch();
            }}
          >
            Retry
          </Button>
        </div>
      )}
      {reads.isPending ? (
        <LoadingRows rows={3} />
      ) : (
        reads.data !== undefined && (
          <>
            <p className="px-4 text-sm text-label-2">
              In your wallet:{" "}
              <span className="tabular font-semibold text-label">
                {factoryValue(reads.data.wallet)}
              </span>
            </p>
            <DelegationPositions
              positions={positions}
              agents={agents}
              disabled={disabled}
              onEdit={(target, nextMode) => {
                setAccount(target);
                setMode(nextMode);
              }}
              onCancel={(target) => direct("cancel", target)}
              onWithdraw={(target) => direct("withdraw", target)}
            />
          </>
        )
      )}
      {directory.isError && (
        <ErrorText>
          The directory is unavailable. You can still manage existing positions once their chain
          reads answer.
        </ErrorText>
      )}
      {operation !== null ? (
        <Section title="Confirm your position action">
          <p className="px-4 text-sm text-label-2">
            Backing wallet: {operation.account}. Withdrawals return to your signed-in wallet.
          </p>
          <TxSteps
            key={operation.id}
            taskId={`delegation:${operation.id}`}
            txs={operation.txs}
            owner={owner}
            reportToBoard={false}
            requireJournal
            retainRecord
            verifyReceipt
            allowSponsorship={false}
            onSafeToRestartChange={setSafeToDismiss}
            {...vaultOperationGuards(stakeContext(contracts), localStorage, key, operation, owner)}
            onDone={() => {
              void withVaultIntentLock(navigator.locks, key, async () => {
                if (!(await clearOwnedIntentDurable(localStorage, key, operation.id)))
                  throw new Error(
                    "A newer position action is saved in another tab; keep it for reconciliation.",
                  );
                setOperation(null);
                void queryClient.invalidateQueries({ queryKey: ["delegations"] });
                void queryClient.invalidateQueries({ queryKey: ["backing"] });
                void queryClient.invalidateQueries({ queryKey: ["indexed-backing"] });
                toast(
                  operation.kind === "delegate"
                    ? "Delegated. You own the position."
                    : operation.kind === "leave"
                      ? "Leaving started. Your position stays at risk."
                      : operation.kind === "cancel"
                        ? "Leaving cancelled. Your backing is active again."
                        : operation.kind === "withdraw"
                          ? "Withdrawn to your wallet."
                          : "Holding permission updated.",
                );
              }).catch((failure) => setError(friendlyError(failure)));
            }}
          />
          {error !== null && <ErrorText>{error}</ErrorText>}
          {safeToDismiss && (
            <Button
              variant="plain"
              onClick={() => {
                const journalKey = txJournalKey(`delegation:${operation.id}`, operation.txs);
                void withWalletStepLock(navigator.locks, journalKey, async () => {
                  const journal = readTxJournal(localStorage, journalKey, true)!;
                  if (
                    journal.pending !== null ||
                    journal.hashes.some((hash) => hash !== null) ||
                    journal.sponsor != null
                  )
                    throw new Error(
                      "This action started in another tab. Reconcile it before preparing another.",
                    );
                  await withVaultIntentLock(navigator.locks, key, async () => {
                    if (!(await clearOwnedIntentDurable(localStorage, key, operation.id)))
                      throw new Error(
                        "A newer position action is saved in another tab; keep it for reconciliation.",
                      );
                    setOperation(null);
                  });
                }).catch((failure) => setError(friendlyError(failure)));
              }}
            >
              Not now
            </Button>
          )}
        </Section>
      ) : (
        <DelegationForm
          account={account}
          owner={owner}
          agents={agents.filter((agent) => agent.ownership === "verified")}
          mode={mode}
          text={text}
          wallet={reads.data?.wallet}
          active={selected.data?.position?.activeValue}
          cooldown={reads.data?.cooldown}
          disabled={disabled}
          busy={busy}
          error={error}
          onAccount={setAccount}
          onMode={setMode}
          onText={setText}
          onSubmit={() => void submit()}
          hasMore={directory.hasNextPage}
          loadingMore={directory.isFetchingNextPage}
          onLoadMore={() => void directory.fetchNextPage()}
        />
      )}
      {reads.data?.open === false && (
        <p role="status" className="rounded-xl bg-tint/10 p-4 text-sm">
          Delegating opens at launch, once the first Holding is authorized. Your FACTORY stays in
          your wallet until then.
        </p>
      )}
      <HoldingControls
        contracts={contracts}
        account={owner}
        disabled={disabled}
        onVeto={(holding, denied) => {
          void prepare(
            "veto",
            owner,
            denied ? "Refuse the Holding for my wallet" : "Allow the Holding for my wallet",
            encodeFunctionData({
              abi: sdk.stakeVaultAbi,
              functionName: "setHoldingDenied",
              args: [holding, denied],
            }),
          ).catch((failure) => setError(friendlyError(failure)));
        }}
      />
    </>
  );
}
