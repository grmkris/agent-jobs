import * as sdk from "@agent-jobs/sdk";
import { useSignTypedData as usePrivySignTypedData } from "@privy-io/react-auth";
import { useEffect, useState } from "react";
import {
  type Address,
  type Hex,
  createPublicClient,
  encodeFunctionData,
  erc20Abi,
  http,
  isAddress,
  parseUnits,
  recoverAddress,
  toHex,
} from "viem";
import { agentEndpoint, type ManagedAgent } from "../api.ts";
import { useAuth } from "./Wallet.tsx";
import { Button, ErrorText, Input, Section, Select } from "./ui.tsx";
import { TxSteps } from "./TxSteps.tsx";
import { chain, deployment } from "../wallet.ts";
import { typedDataArgs } from "../typed-data.ts";
import { recoveryExpiry, recoveryReplacementAllowed, type RecoveryPlan } from "./recovery-plan.ts";
import { initializeTxJournal, readTxJournal, txJournalKey } from "./txJournal.ts";
import { withWalletStepLock } from "./txOperation.ts";
import { useBacking } from "../delegation-query.ts";

interface KnownGrant {
  hash: Hex;
  delegation: unknown;
  status: string;
}
export function EmergencyRecovery({ initialAgent }: { initialAgent?: ManagedAgent }) {
  const { address: operator } = useAuth();
  if (operator === undefined) return null;
  return <Recovery operator={operator} {...(initialAgent === undefined ? {} : { initialAgent })} />;
}

function Recovery({ operator, initialAgent }: { operator: Address; initialAgent?: ManagedAgent }) {
  const cacheKey = `hireling.recovery:${operator.toLowerCase()}:${initialAgent?.id ?? "manual"}`;
  const planKey = `${cacheKey}:plan`;
  const historyKey = `${cacheKey}:history`;
  const { signTypedData } = usePrivySignTypedData();
  const [address, setAddress] = useState(initialAgent?.address ?? "");
  const [action, setAction] = useState("sweep");
  const recoveryWallet = isAddress(address) ? address : undefined;
  const owned = useBacking(recoveryWallet, recoveryWallet);
  const ownPosition = owned.isError ? undefined : owned.data?.position;
  const [token, setToken] = useState<string>(deployment.factory);
  const [units, setUnits] = useState("");
  const [known, setKnown] = useState<KnownGrant[]>(() => {
    try {
      return (
        (JSON.parse(localStorage.getItem(cacheKey) ?? "{}") as { grants?: KnownGrant[] }).grants ??
        []
      );
    } catch {
      return [];
    }
  });
  const [disableHash, setDisableHash] = useState("");
  const [plan, setPlan] = useState<RecoveryPlan | null>(() => {
    try {
      return JSON.parse(localStorage.getItem(planKey) ?? "null") as RecoveryPlan | null;
    } catch {
      return null;
    }
  });
  const [safeToRestart, setSafeToRestart] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const expiry =
    plan === null ? null : recoveryExpiry(plan, deployment.delegation.enforcers.timestamp);
  useEffect(() => {
    if (initialAgent === undefined) return;
    void agentEndpoint<{ grants: KnownGrant[] }>(`/api/agents/${initialAgent.id}/recovery`)
      .then((response) => {
        setKnown(response.grants);
        try {
          localStorage.setItem(cacheKey, JSON.stringify(response));
        } catch {
          /* Manual exact actions remain available without a grant inventory. */
        }
      })
      .catch(() => {
        /* Previously cached metadata and direct RPC recovery remain available. */
      });
  }, [initialAgent?.id, operator]);
  function save(next: RecoveryPlan) {
    if (next.tx !== undefined) initializeTxJournal(localStorage, `emergency-${next.id}`, [next.tx]);
    localStorage.setItem(planKey, JSON.stringify(next));
    if (localStorage.getItem(planKey) !== JSON.stringify(next))
      throw new Error("Recovery journal could not be saved; no transaction may start");
    setPlan(next);
  }
  async function run(work: () => Promise<void>) {
    setBusy(true);
    setError(null);
    try {
      await work();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "Recovery is unavailable");
    } finally {
      setBusy(false);
    }
  }
  async function prepare() {
    if (!isAddress(address) || address.toLowerCase() === operator.toLowerCase())
      throw new Error("Enter an agent wallet owned by your Privy account");
    const rpc = createPublicClient({ chain, transport: http() });
    let call: sdk.Execution;
    let description: string;
    let direct = false;
    if (action === "cancel" || action === "request" || action === "withdraw") {
      if (deployment.hireling === null) throw new Error("The vault is unavailable");
      if (action === "request" && !/^\d+(?:\.\d{1,18})?$/.test(units))
        throw new Error("Enter a positive FACTORY amount");
      const quantity = action === "request" ? parseUnits(units, 18) : 0n;
      if (action === "request" && quantity <= 0n)
        throw new Error("Enter a positive FACTORY amount");
      const shares =
        action === "request"
          ? await sdk.undelegationShares(
              { publicClient: rpc, deployment, stack: deployment.stacks.main! },
              address,
              address,
              quantity,
            )
          : 0n;
      call = {
        target: deployment.hireling.vault,
        value: 0n,
        callData:
          action === "request"
            ? encodeFunctionData({
                abi: sdk.stakeVaultAbi,
                functionName: "requestUndelegate",
                args: [address, shares],
              })
            : action === "cancel"
              ? encodeFunctionData({
                  abi: sdk.stakeVaultAbi,
                  functionName: "cancelUndelegate",
                  args: [address],
                })
              : encodeFunctionData({
                  abi: sdk.stakeVaultAbi,
                  functionName: "withdraw",
                  args: [address],
                }),
      };
      description =
        action === "request"
          ? `Request leaving ${units} FACTORY from the agent-owned position`
          : action === "cancel"
            ? "Cancel leaving the agent-owned position"
            : "Withdraw unlocked FACTORY to the agent wallet";
    } else if (action === "native") {
      const balance = await rpc.getBalance({ address });
      if (balance === 0n) throw new Error("The agent has no native MON to sweep");
      call = { target: operator, value: balance, callData: "0x" };
      description = "Sweep all native MON from the agent to your operator wallet";
    } else if (action === "sweep") {
      if (!isAddress(token)) throw new Error("Enter the token contract address");
      const balance = await rpc.readContract({
        address: token,
        abi: erc20Abi,
        functionName: "balanceOf",
        args: [address],
      });
      if (balance === 0n) throw new Error("This token balance is empty");
      call = sdk.advanceExecution(token, operator, balance);
      description = `Sweep the whole token balance (${balance} base units) to your operator wallet`;
    } else {
      const entry = known.find((row) => row.hash === disableHash);
      if (entry === undefined) throw new Error("Select a known delegation");
      const grant = sdk.parseDelegation(JSON.stringify(entry.delegation));
      if (sdk.delegationHash(grant) !== entry.hash)
        throw new Error("The cached delegation hash differs");
      if (![address.toLowerCase(), operator.toLowerCase()].includes(grant.delegator.toLowerCase()))
        throw new Error("This delegation belongs to another wallet");
      direct = grant.delegator.toLowerCase() === operator.toLowerCase();
      call = {
        target: deployment.delegation.manager,
        value: 0n,
        callData: sdk.disableCalldata(grant),
      };
      description = `Disable known permission ${entry.hash}`;
    }
    const id = crypto.randomUUID();
    const grant = direct
      ? null
      : sdk.delegationJson(
          sdk.recoveryGrant(
            deployment,
            address,
            operator,
            call,
            BigInt(toHex(crypto.getRandomValues(new Uint8Array(32)))),
            Math.floor(Date.now() / 1000),
          ),
        );
    const next: RecoveryPlan = {
      id,
      operator,
      agent: address,
      call: { ...call, value: call.value.toString() },
      grant,
      description,
      action,
      token,
      units,
    };
    if (direct)
      next.tx = {
        to: call.target,
        data: call.callData,
        value: "0",
        chainId: chain.id,
        description,
      };
    save(next);
  }
  async function sign() {
    if (plan === null || plan.grant === null) return;
    if (plan.operator.toLowerCase() !== operator.toLowerCase())
      throw new Error("This recovery journal belongs to another operator");
    if (expiry !== null) {
      const block = await createPublicClient({ chain, transport: http() }).getBlock();
      if (Number(block.timestamp) >= expiry)
        throw new Error("This recovery permission expired; prepare a fresh action");
    }
    const grant = sdk.parseDelegation(plan.grant);
    const typedData = sdk.delegationTypedData(deployment, grant);
    const signature = (await signTypedData(typedDataArgs(typedData), { address: plan.agent }))
      .signature as Hex;
    if (
      (
        await recoverAddress({ hash: sdk.delegationDigest(deployment, grant), signature })
      ).toLowerCase() !== plan.agent.toLowerCase()
    )
      throw new Error("Privy did not sign as the requested agent wallet");
    const execution = { ...plan.call, value: BigInt(plan.call.value) };
    save({
      ...plan,
      tx: {
        chainId: chain.id,
        description: plan.description,
        to: deployment.delegation.manager,
        value: "0",
        data: sdk.redeemCallsCalldata({ ...grant, signature }, [execution]),
      },
    });
  }
  async function replaceExpired() {
    if (
      plan === null ||
      plan.tx === undefined ||
      plan.operator.toLowerCase() !== operator.toLowerCase()
    )
      throw new Error("This recovery attempt is unavailable");
    const key = txJournalKey(`emergency-${plan.id}`, [plan.tx]);
    await withWalletStepLock(navigator.locks, key, async () => {
      const journal = readTxJournal(localStorage, key, true)!;
      const block = await createPublicClient({ chain, transport: http() }).getBlock();
      if (
        !recoveryReplacementAllowed(expiry, Number(block.timestamp), safeToRestart) ||
        journal.pending !== null ||
        journal.hashes.some((hash) => hash !== null)
      )
        throw new Error("Reconcile the old recovery attempt and wait for its permission to expire");
      const history = [
        ...(JSON.parse(localStorage.getItem(historyKey) ?? "[]") as RecoveryPlan[]),
        plan,
      ];
      localStorage.setItem(historyKey, JSON.stringify(history));
      if (localStorage.getItem(historyKey) !== JSON.stringify(history))
        throw new Error("Recovery history could not be saved");
      localStorage.removeItem(planKey);
      setAddress(plan.agent);
      setAction(plan.action);
      setToken(plan.token);
      setUnits(plan.units);
      setPlan(null);
      setSafeToRestart(false);
    });
  }
  return (
    <details className="rounded-xl border border-sep p-4">
      <summary className="min-h-8 cursor-pointer font-semibold">
        Emergency recovery · Privy + RPC only
      </summary>
      <Section note="You sign one fresh permission as the agent, without changing the website wallet. Your operator redeems it and pays gas. This works without Hireling’s API or relay, provided Privy and the RPC are available.">
        <p className="mt-3 text-xs text-label-2">
          Only known permissions can be individually disabled. This panel can leave only the
          agent-owned mining position; operator-funded backing belongs to the operator. Funds
          reserved for jobs and immediate bond slashes cannot be recovered by this panel. Full 7702
          retirement remains a separate verification gate.
        </p>
        {plan === null ? (
          <>
            <label className="grid gap-1 text-sm">
              <span>Agent wallet</span>
              <Input
                value={address}
                onChange={(event) => setAddress(event.target.value)}
                aria-label="Agent recovery wallet"
              />
            </label>
            <Select
              value={action}
              onChange={(event) => setAction(event.target.value)}
              aria-label="Recovery action"
            >
              {ownPosition !== null &&
                ownPosition !== undefined &&
                ownPosition.queuedShares > 0n && (
                  <option value="cancel">Cancel leaving (agent-owned)</option>
                )}
              {ownPosition !== null &&
                ownPosition !== undefined &&
                ownPosition.activeShares > 0n && (
                  <option value="request">Request leaving (agent-owned)</option>
                )}
              {ownPosition !== null &&
                ownPosition !== undefined &&
                ownPosition.queuedShares > 0n && (
                  <option value="withdraw">Withdraw after cooldown (agent-owned)</option>
                )}
              <option value="sweep">Sweep token earnings</option>
              <option value="native">Sweep native MON</option>
              <option value="disable">Disable a known permission</option>
            </Select>
            {action === "request" && (
              <Input
                value={units}
                onChange={(event) => setUnits(event.target.value)}
                placeholder="FACTORY amount"
                aria-label="Recovery agent-owned amount to leave"
              />
            )}
            {action === "sweep" && (
              <Input
                value={token}
                onChange={(event) => setToken(event.target.value)}
                aria-label="Recovery token contract"
              />
            )}
            {action === "disable" && (
              <Select
                value={disableHash}
                onChange={(event) => setDisableHash(event.target.value)}
                aria-label="Known permission to disable"
              >
                <option value="">Choose a known permission</option>
                {known.map((row) => (
                  <option key={row.hash} value={row.hash}>
                    {row.hash} · {row.status}
                  </option>
                ))}
              </Select>
            )}
            <Button busy={busy} onClick={() => void run(prepare)}>
              Review exact recovery action
            </Button>
          </>
        ) : (
          <>
            <p className="font-semibold">{plan.description}</p>
            <p className="break-all text-xs text-label-2">
              Agent {plan.agent} → operator {plan.operator}. One exact call, 10-minute permission.
            </p>
            {plan.tx === undefined ? (
              <Button busy={busy} onClick={() => void run(sign)}>
                Sign as this agent in Privy
              </Button>
            ) : (
              <TxSteps
                taskId={`emergency-${plan.id}`}
                txs={[plan.tx]}
                owner={operator}
                allowBatch={false}
                allowSponsorship={false}
                reportToBoard={false}
                retainRecord
                verifyReceipt
                requireJournal
                onSafeToRestartChange={setSafeToRestart}
                sendGuard={async () =>
                  expiry !== null &&
                  Number(
                    (await createPublicClient({ chain, transport: http() }).getBlock()).timestamp,
                  ) >= expiry
                    ? "This recovery permission expired; prepare a fresh action"
                    : null
                }
                onDone={() => {
                  localStorage.removeItem(planKey);
                  setPlan(null);
                }}
              />
            )}
            {plan.tx !== undefined && expiry !== null && safeToRestart && (
              <Button variant="plain" busy={busy} onClick={() => void run(replaceExpired)}>
                Prepare a fresh recovery attempt
              </Button>
            )}
            {plan.tx === undefined && (
              <Button
                variant="plain"
                disabled={busy}
                onClick={() => {
                  localStorage.removeItem(planKey);
                  setPlan(null);
                }}
              >
                Discard unsigned action
              </Button>
            )}
          </>
        )}
        {error !== null && <ErrorText>{error}</ErrorText>}
      </Section>
    </details>
  );
}
