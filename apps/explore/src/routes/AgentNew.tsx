import { usePrivy } from "@privy-io/react-auth";
import { useQueryClient } from "@tanstack/react-query";
import { useSearch } from "@tanstack/react-router";
import { useState } from "react";
import { type Address } from "viem";
import { useSignTypedData } from "wagmi";
import { agentEndpoint, type ManagedAgent } from "../api.ts";
import { agentAction, prepareRegistration } from "../agent-api.ts";
import { reviewAgentGrant } from "../agent-grant.ts";
import { AgentGrantReview } from "../components/AgentGrantReview.tsx";
import { BoardLink } from "../components/BoardLink.tsx";
import { OperatorGrant } from "../components/OperatorGrant.tsx";
import { PrivyLogin } from "../components/Privy.tsx";
import { Button, ErrorText, Input, PageTitle, Section } from "../components/ui.tsx";
import { useAuth } from "../components/Wallet.tsx";
import { agentHome, useManagedAgents } from "../managed.ts";
import { AllowanceEditor } from "../components/AllowanceEditor.tsx";
import { AgentStake } from "../components/AgentStake.tsx";
import { ConnectionCard } from "../components/ConnectionCard.tsx";
import { typedDataArgs } from "../typed-data.ts";
import { privyAppId } from "../wallet.ts";

/** Create an agent, or (`?resume=<id>`) continue the setup of one that has no Agent ID yet. */
export function AgentNewPage() {
  const { resume } = useSearch({ strict: false }) as { resume?: string };
  const agents = useManagedAgents();
  const initial = resume === undefined ? undefined : agents.data?.agents.find((agent) => agent.id === resume);
  return (
    <>
      <PageTitle sub="Your wallet owns the identity. The agent has its own wallet.">
        {resume === undefined ? "Create an agent" : "Finish setting up your agent"}
      </PageTitle>
      {resume !== undefined && initial === undefined ? (
        agents.isLoading ? (
          <p className="text-label-2">Reading your agent records…</p>
        ) : (
          <ErrorText>That agent is not one of yours, or its records are unavailable. Sign in with its operator wallet.</ErrorText>
        )
      ) : (
        <AgentNew {...(initial === undefined ? {} : { initial })} />
      )}
    </>
  );
}

export function AgentNew({
  initial,
  onReady,
  context = "standalone",
}: {
  initial?: ManagedAgent;
  onReady?: (agent: ManagedAgent) => void;
  context?: "standalone" | "oauth";
}) {
  const auth = useAuth();
  if (privyAppId === "" || !auth.signedIn || auth.address === undefined)
    return (
      <Section title="Sign in first">
        <p className="text-label-2">Sign in with your operator wallet to create an agent.</p>
        <PrivyLogin />
      </Section>
    );
  return (
    <AgentSetup
      key={initial?.id ?? auth.address}
      operator={auth.address}
      context={context}
      {...(initial === undefined ? {} : { initial })}
      {...(onReady === undefined ? {} : { onReady })}
    />
  );
}

function AgentSetup({
  operator,
  initial,
  onReady,
  context,
}: {
  operator: Address;
  initial?: ManagedAgent;
  onReady?: (agent: ManagedAgent) => void;
  context: "standalone" | "oauth";
}) {
  const { getAccessToken } = usePrivy();
  const queryClient = useQueryClient();
  const { signTypedDataAsync } = useSignTypedData();
  const [name, setName] = useState(initial?.name ?? "");
  const [draft] = useState(() => {
    if (initial !== undefined) return { id: initial.id, name: initial.name };
    try {
      const saved = JSON.parse(
        localStorage.getItem(`hireling.agent-draft:${operator}`) ?? "null",
      ) as { id: string; name: string } | null;
      if (saved !== null) return saved;
    } catch {
      /* This tab keeps the same intent without storage. */
    }
    return { id: crypto.randomUUID(), name: "" };
  });
  const [agent, setAgent] = useState(initial);
  const [operatorReady, setOperatorReady] = useState(false);
  const [fundingReady, setFundingReady] = useState(false);
  const [review, setReview] = useState<ReturnType<typeof reviewAgentGrant> | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function run(action: () => Promise<void>) {
    setBusy(true);
    setError(null);
    try {
      await action();
    } catch (failure) {
      setError(
        failure instanceof Error ? failure.message : "Setup is unavailable; retry this step",
      );
    } finally {
      setBusy(false);
    }
  }
  async function create() {
    if (draft.name === "") draft.name = name.trim() || "My coding agent";
    try {
      localStorage.setItem(`hireling.agent-draft:${operator}`, JSON.stringify(draft));
    } catch {
      /* The in-memory identity still survives retries. */
    }
    const token = await getAccessToken();
    setAgent(await agentEndpoint<ManagedAgent>("/api/agents", "POST", draft, token ?? undefined));
    await queryClient.invalidateQueries({ queryKey: ["managed-agents", operator] });
  }
  async function prepare() {
    if (agent === undefined) return;
    const prepared = await prepareRegistration(agent.id);
    setReview(reviewAgentGrant(prepared, { kind: "registration", delegator: operator }));
  }
  async function register() {
    if (agent === undefined || review === null) return;
    const signatureKey = `hireling.registration-signature:${operator}:${agent.id}`;
    const saved = JSON.parse(localStorage.getItem(signatureKey) ?? "null") as {
      hash: string;
      signature: string;
    } | null;
    const signature =
      saved?.hash === review.hash
        ? saved.signature
        : await signTypedDataAsync(typedDataArgs(review.typedData));
    localStorage.setItem(signatureKey, JSON.stringify({ hash: review.hash, signature }));
    const response = await agentAction<ManagedAgent | { status: string }>(
      agent.id,
      "registration-confirm",
      { hash: review.hash, signature },
    );
    if (!("state" in response))
      throw new Error(
        `Registration is ${response.status}. Retry this step to reconcile the saved sends.`,
      );
    setAgent(response);
    setReview(null);
    await queryClient.invalidateQueries({ queryKey: ["managed-agents", operator] });
    try {
      localStorage.removeItem(`hireling.agent-draft:${operator}`);
    } catch {
      /* Setup is already durably stored. */
    }
  }
  return (
    <div className="grid gap-6">
      <ol className="grid grid-cols-3 gap-2 border-b border-sep pb-4 text-xs">
        <li className={agent === undefined ? "font-semibold text-tint" : "text-label-2"}>
          01 · Name & wallet
        </li>
        <li
          className={
            agent !== undefined && agent.state !== "active"
              ? "font-semibold text-tint"
              : "text-label-2"
          }
        >
          02 · Registration
        </li>
        <li className={agent?.state === "active" ? "font-semibold text-tint" : "text-label-2"}>
          {context === "oauth" ? "03 · Connection" : "03 · Permissions"}
        </li>
      </ol>
      {agent === undefined ? (
        <Section
          title="Name your coding agent"
          note="The server creates a separate Privy wallet owned by your account. The routine signer prepares its upgrade and gas grants."
        >
          <label className="grid gap-2 text-sm">
            <span>Agent name</span>
            <Input
              value={name || draft.name}
              onChange={(event) => setName(event.target.value)}
              maxLength={100}
              placeholder="My coding agent"
            />
          </label>
          <Button busy={busy} onClick={() => void run(create)}>
            Create agent wallet
          </Button>
        </Section>
      ) : agent.state !== "active" ? (
        <>
          <Section
            title={agent.name}
            note={`Setup saved · ${agent.state}. Retry resumes the same wallet and registration.`}
          >
            {["created", "upgraded"].includes(agent.state) ? (
              <Button
                busy={busy}
                onClick={() =>
                  void run(async () =>
                    setAgent(await agentAction<ManagedAgent>(agent.id, "resume")),
                  )
                }
              >
                Resume wallet setup
              </Button>
            ) : !operatorReady ? (
              <OperatorGrant operator={operator} onReady={() => setOperatorReady(true)} />
            ) : review === null ? (
              <Button busy={busy} onClick={() => void run(prepare)}>
                Review registration grant
              </Button>
            ) : (
              <>
                <AgentGrantReview description={review.description} />
                <Button busy={busy} onClick={() => void run(register)}>
                  Sign registration permission
                </Button>
              </>
            )}
          </Section>
        </>
      ) : (
        <>
          <Section
            title={`Agent #${agent.agent_id} is registered`}
            note="Its NFT belongs to your operator wallet. The agent wallet holds its earnings and job obligations. Each backer keeps ownership of its FACTORY position."
          >
            <p className="text-sm text-label-2">
              {context === "oauth" ? "You can connect now. Spending allowance and FACTORY backing can be added later." : "Work and hire are available by default. Review the connection permissions when your MCP client opens OAuth."}
            </p>
            {context === "oauth" && onReady !== undefined && (
              <Button onClick={() => onReady(agent)}>Use this agent for this connection</Button>
            )}
            {context === "oauth" ? (
              <details className="border-t border-sep pt-3">
                <summary className="cursor-pointer text-sm font-semibold">Optional weekly spending allowance</summary>
                <div className="pt-3"><AllowanceEditor agent={agent} onConfirmed={() => setFundingReady(true)} /></div>
              </details>
            ) : <AllowanceEditor agent={agent} onConfirmed={() => setFundingReady(true)} />}
          </Section>
          {context === "oauth" ? (
            <details>
              <summary className="cursor-pointer text-sm font-semibold">Optional FACTORY backing</summary>
              <div className="pt-3"><AgentStake agent={agent} operator={operator} /></div>
            </details>
          ) : <AgentStake agent={agent} operator={operator} />}
          {context === "standalone" && <ConnectionCard />}
          {context === "standalone" && onReady !== undefined && (
            <Button disabled={!fundingReady} onClick={() => onReady(agent)}>
              Use this agent for this connection
            </Button>
          )}
          {onReady === undefined && (
            <BoardLink target={agentHome(agent)} className="min-h-11 content-center font-semibold text-tint">
              Open this agent
            </BoardLink>
          )}
        </>
      )}
      {error !== null && <ErrorText>{error}</ErrorText>}
    </div>
  );
}
