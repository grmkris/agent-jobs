import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { agentEndpoint, type ManagedAgent } from "../api.ts";
import { AgentNew } from "../routes/AgentNew.tsx";
import { AllowanceEditor } from "./AllowanceEditor.tsx";
import { AgentStake } from "./AgentStake.tsx";
import { Button, EmptyState, ErrorText, Section, Select } from "./ui.tsx";
import { useAuth } from "./Wallet.tsx";
import { OAuthClient, type OAuthClientIdentity } from "./OAuthClient.tsx";

export function OAuthConsent({ requestId }: { requestId: string }) {
  const auth = useAuth();
  const request = useQuery({
    queryKey: ["oauth-request", requestId, auth.address],
    queryFn: () =>
      agentEndpoint<{
        request: OAuthClientIdentity & { scopes: string[]; resource: string; expiresAt: number };
        agents: ManagedAgent[];
      }>(`/oauth/requests/${requestId}`),
    enabled: auth.signedIn,
    retry: false,
  });
  const agents = useQuery({
    queryKey: ["managed-agents", auth.address],
    queryFn: () => agentEndpoint<{ agents: ManagedAgent[] }>("/api/agents"),
    enabled: auth.signedIn,
  });
  const [selected, setSelected] = useState("");
  const [creating, setCreating] = useState(false);
  const [work, setWork] = useState(true);
  const [hire, setHire] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const agent = agents.data?.agents.find((row) => row.id === selected);
  async function decide(approved: boolean) {
    setBusy(true);
    setError(null);
    try {
      const scopes =
        request.data?.request.scopes.filter((scope) =>
          scope === "hireling:work" ? work : scope === "hireling:hire" ? hire : true,
        ) ?? [];
      const response = await agentEndpoint<{ redirectUrl: string }>(
        `/oauth/requests/${requestId}/approve`,
        "POST",
        { decision: approved ? "approve" : "reject", agentIds: [selected], scopes },
      );
      const url = new URL(response.redirectUrl);
      if (
        url.protocol !== "https:" &&
        !(url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))
      )
        throw new Error("The client redirect is unavailable");
      window.location.assign(url.href);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "OAuth consent is unavailable");
    } finally {
      setBusy(false);
    }
  }
  if (!auth.signedIn)
    return (
      <EmptyState title="Sign in to connect">
        Use the operator wallet that owns the agent.
      </EmptyState>
    );
  if (request.error !== null)
    return (
      <ErrorText>
        This connection request is unavailable or expired. Restart authentication from your coding
        client; your saved agent remains registered.
      </ErrorText>
    );
  return (
    <div className="grid gap-6">
      <Section
        title="Connect one agent"
        note={request.data?.request.resource ?? "Loading connection request…"}
      >
        {request.data !== undefined && <OAuthClient client={request.data.request} />}
        <label className="grid gap-2 text-sm">
          <span>Agent</span>
          <Select value={selected} onChange={(event) => setSelected(event.target.value)}>
            <option value="">Choose an active agent</option>
            {agents.data?.agents
              .filter((row) => row.state === "active")
              .map((row) => (
                <option key={row.id} value={row.id}>
                  {row.name} · #{row.agent_id}
                </option>
              ))}
          </Select>
        </label>
        <Button variant="plain" onClick={() => setCreating(!creating)}>
          {creating ? "Close agent setup" : "Create a new agent"}
        </Button>
        {creating && (
          <AgentNew
            context="oauth"
            onReady={(created) => {
              setSelected(created.id);
              setCreating(false);
              void agents.refetch();
            }}
          />
        )}
      </Section>
      {agent !== undefined && (
        <Section title="Connection permissions">
          <p className="font-semibold">Agent #{agent.agent_id} is registered</p>
          {request.data?.request.scopes.includes("hireling:work") && (
            <label className="flex min-h-11 items-center gap-3">
              <input
                type="checkbox"
                checked={work}
                onChange={(event) => setWork(event.target.checked)}
              />
              <span>Work · apply, quote, activate, deliver and dispute</span>
            </label>
          )}
          {request.data?.request.scopes.includes("hireling:hire") && (
            <label className="flex min-h-11 items-center gap-3">
              <input
                type="checkbox"
                checked={hire}
                onChange={(event) => setHire(event.target.checked)}
              />
              <span>Hire · post, select, accept and reject</span>
            </label>
          )}
          <p className="text-sm text-label-2">
            The spending allowance limits transfers of reward tokens. It does not cap bond exposure:
            an agent can activate any bonded job, and a slash is immediate.
          </p>
          <Button
            busy={busy}
            disabled={agent.state !== "active" || request.data === undefined}
            onClick={() => void decide(true)}
          >
            Use this agent for this connection
          </Button>
          <p className="text-sm text-label-2">Spending allowance and FACTORY backing can be added later.</p>
          {hire && request.data?.request.scopes.includes("hireling:hire") && (
            <details>
              <summary className="cursor-pointer text-sm font-semibold">Optional weekly spending allowance</summary>
              <div className="pt-3"><AllowanceEditor agent={agent} onConfirmed={() => undefined} /></div>
            </details>
          )}
          <details>
            <summary className="cursor-pointer text-sm font-semibold">Optional FACTORY backing</summary>
            <div className="pt-3"><AgentStake agent={agent} operator={auth.address!} /></div>
          </details>
        </Section>
      )}
      <Button variant="plain" disabled={busy} onClick={() => void decide(false)}>
        Deny connection
      </Button>
      {error !== null && <ErrorText>{error}</ErrorText>}
    </div>
  );
}
