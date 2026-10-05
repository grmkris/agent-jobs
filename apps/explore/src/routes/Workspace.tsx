import { useSigners } from "@privy-io/react-auth";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useState } from "react";
import { agentEndpoint, type ManagedAgent } from "../api.ts";
import { agentAction, agentStatus } from "../agent-api.ts";
import { AllowanceEditor } from "../components/AllowanceEditor.tsx";
import { ConnectionCard } from "../components/ConnectionCard.tsx";
import { Badge, Button, EmptyState, ErrorText, PageTitle, Section } from "../components/ui.tsx";
import { useAuth } from "../components/Wallet.tsx";
import { useNow } from "../components/Time.tsx";
import { AgentNew } from "./AgentNew.tsx";
import { AgentBalances } from "../components/AgentBalances.tsx";
import { EmergencyRecovery } from "../components/EmergencyRecovery.tsx";
import { amount } from "../format.ts";
import { useTokenList } from "../useTokens.ts";

export function WorkspacePage() {
  const auth = useAuth();
  const agents = useQuery({
    queryKey: ["managed-agents", auth.address],
    queryFn: () => agentEndpoint<{ agents: ManagedAgent[] }>("/api/agents"),
    enabled: auth.signedIn,
    refetchInterval: 15000,
  });
  return (
    <>
      <PageTitle sub="One identity, wallet and spending allowance for each coding agent.">
        Your workspace
      </PageTitle>
      <div className="flex flex-wrap gap-3">
        <Link to="/agents/new" className="action-link">
          Create an agent
        </Link>
        <Link to="/approvals" className="action-link secondary">
          Review approvals
        </Link>
      </div>
      {!auth.signedIn ? (
        <EmptyState title="Sign in to manage your agents">
          Use your operator wallet; it remains the website wallet throughout setup and work.
        </EmptyState>
      ) : agents.error !== null ? (
        <>
          <ErrorText>
            Agent records are unavailable. Your chain funds and existing permissions remain at their
            recorded addresses.
          </ErrorText>
          <EmergencyRecovery />
        </>
      ) : agents.isLoading ? (
        <p className="text-label-2">Reading your agent records…</p>
      ) : agents.data?.agents.length === 0 ? (
        <EmptyState title="Your first agent starts here">
          Create an agent, review its permissions, then connect your coding client.
        </EmptyState>
      ) : (
        agents.data?.agents.map((agent) => <ManagedAgentCard key={agent.id} agent={agent} />)
      )}
      <ConnectionCard />
    </>
  );
}

function ManagedAgentCard({ agent }: { agent: ManagedAgent }) {
  const auth = useAuth();
  const queryClient = useQueryClient();
  const { removeSigners } = useSigners();
  const status = useQuery({
    queryKey: ["managed-agent-status", agent.id, auth.address],
    queryFn: () => agentStatus(agent.id),
    refetchInterval: 20000,
  });
  const now = useNow();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [operationKey, setOperationKey] = useState(() => crypto.randomUUID());
  const stopped = agent.state === "revoked";
  const last =
    agent.last_activity_at === null
      ? "Unknown · no observed MCP call"
      : `${new Date(agent.last_activity_at * 1000).toLocaleString()}${now - agent.last_activity_at > 86400 ? " · stale" : ""}`;
  useTokenList(status.data?.allowances.map((row) => row.token) ?? []);
  async function refresh() {
    await queryClient.invalidateQueries({ queryKey: ["managed-agents"] });
    await status.refetch();
  }
  async function revoke() {
    setBusy(true);
    setError(null);
    const failures: string[] = [];
    try {
      await agentAction(agent.id, "stop-access");
      await refresh();
      if (agent.address !== null) {
        try {
          await removeSigners({ address: agent.address });
          await agentAction(agent.id, "signer-removed");
        } catch {
          failures.push(
            "Hosted actions have stopped. Privy signer removal is still unconfirmed; retry removal.",
          );
        }
      }
      try {
        await agentAction(agent.id, "revoke");
      } catch {
        failures.push(
          "On-chain disablement is incomplete. Reconcile again, renew operator sponsorship if needed, or use emergency recovery.",
        );
      }
      await refresh();
      setError(failures.length === 0 ? null : failures.join(" "));
    } catch (failure) {
      setError(
        failure instanceof Error
          ? failure.message
          : "Could not stop access; no revocation is claimed",
      );
    } finally {
      setBusy(false);
    }
  }
  return (
    <article className="grid gap-5 rounded-2xl border border-sep bg-surface p-5 shadow-float">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="font-display text-2xl font-semibold">{agent.name}</h2>
          <p className="mt-1 text-xs text-label-2">
            {agent.agent_id === null ? "Registration incomplete" : `ERC-8004 #${agent.agent_id}`} ·{" "}
            {agent.address ?? "Wallet creation pending"}
          </p>
        </div>
        <Badge tone={agent.state === "active" ? "success" : "neutral"}>{agent.state}</Badge>
      </header>
      <p className="text-sm text-label-2">
        <strong className="font-medium text-label">Last activity:</strong> {last}. This is
        server-observed activity, not a health signal.
      </p>
      {!stopped && agent.state !== "active" && <AgentNew initial={agent} />}
      {agent.state === "active" && (
        <>
          <Section title="Spending limit">
            {status.error !== null ? (
              <ErrorText>Allowance usage is unavailable; no remaining budget is assumed.</ErrorText>
            ) : status.data?.allowances.length === 0 ? (
              <p className="text-sm text-label-2">
                No live periodic allowance. Hires go to Approvals.
              </p>
            ) : (
              status.data?.allowances.map((row) => (
                <div key={row.hash} className="grid gap-1 border-l-2 border-tint pl-4">
                  <strong>
                    {amount(row.left, row.token)} left of {amount(row.limit, row.token)}
                  </strong>
                  <p className="text-xs text-label-2">
                    Used {amount(row.used, row.token)} · next fixed period{" "}
                    {new Date(row.periodEnd * 1000).toLocaleString()} · expires{" "}
                    {new Date(row.expiresAt * 1000).toLocaleString()}
                  </p>
                </div>
              ))
            )}
            <details className="rounded-xl border border-sep p-3">
              <summary className="min-h-8 cursor-pointer font-medium">
                Change or renew the allowance
              </summary>
              <div className="mt-3">
                <AllowanceEditor agent={agent} onConfirmed={() => void refresh()} />
              </div>
            </details>
          </Section>
          <AgentBalances
            agent={agent}
            operationKey={operationKey}
            onConfirmed={() => {
              setOperationKey(crypto.randomUUID());
              void refresh();
            }}
          />
        </>
      )}
      <Section title="Revocation">
        <p className="text-sm">
          Hosted access:{" "}
          {status.data?.revocation.hostedAccessStopped
            ? status.data.revocation.signerRemoved
              ? "Stopped · Privy signer removal confirmed"
              : "Server stopped · Privy signer removal pending"
            : stopped
              ? "Server stopped · provider status unknown"
              : "Enabled"}
        </p>
        <p className="text-sm">
          On-chain permissions:{" "}
          {status.data?.revocation.onchainPermissionsDisabled
            ? "Disabled · confirmed receipts"
            : "Disablement unconfirmed"}
        </p>
        {status.data?.revocation.receipts?.map((receipt) => (
          <p key={receipt.tx_hash} className="break-all font-mono text-xs text-label-3">
            {receipt.status} · {receipt.tx_hash}
          </p>
        ))}
        <Button variant="danger" busy={busy} onClick={() => void revoke()}>
          {stopped ? "Reconcile revocation and signer removal" : "Stop hosted access and revoke"}
        </Button>
        {error !== null && <ErrorText>{error}</ErrorText>}
      </Section>
      {agent.address !== null && <EmergencyRecovery initialAgent={agent} />}
    </article>
  );
}
