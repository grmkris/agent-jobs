import { Link } from "@tanstack/react-router";
import { ConnectionCard } from "../components/ConnectionCard.tsx";
import { EmptyState, ErrorText, PageTitle } from "../components/ui.tsx";
import { useAuth } from "../components/Wallet.tsx";
import { ManagedAgentCard } from "../components/agent/ManagedAgentCard.tsx";
import { useManagedAgents } from "../managed.ts";

export function WorkspacePage() {
  const auth = useAuth();
  const agents = useManagedAgents();
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
        <ErrorText>
          Agent records are unavailable. Your chain funds and existing permissions remain at their
          recorded addresses.
        </ErrorText>
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
