import { useQueryClient } from "@tanstack/react-query";
import { Approval } from "../components/agent/Approval.tsx";
import { EmptyState, ErrorText, PageTitle } from "../components/ui.tsx";
import { useAuth } from "../components/Wallet.tsx";
import { useManagedAgents, useManagedApprovals } from "../managed.ts";

export function ApprovalsPage() {
  const auth = useAuth();
  const queryClient = useQueryClient();
  const approvals = useManagedApprovals();
  const agents = useManagedAgents();
  const refresh = () =>
    queryClient.invalidateQueries({ queryKey: ["managed-approvals", auth.address] });
  return (
    <>
      <PageTitle sub="Your decisions set exact spending and leaving authority.">
        Approvals
      </PageTitle>
      {!auth.signedIn ? (
        <EmptyState title="Sign in to review decisions">Use your operator wallet.</EmptyState>
      ) : approvals.error !== null || agents.error !== null ? (
        <ErrorText>Approval records are unavailable. No decision has been submitted.</ErrorText>
      ) : approvals.isLoading ? (
        <p className="text-label-2">Reading your pending decisions…</p>
      ) : approvals.data?.approvals.length === 0 ? (
        <EmptyState title="No decisions waiting">
          Within-limit work uses the agent grants.
        </EmptyState>
      ) : (
        approvals.data?.approvals.map((approval) => {
          const agent = agents.data?.agents.find((row) => row.id === approval.agent_id);
          return agent === undefined ? null : (
            <Approval
              key={approval.id}
              approval={approval}
              agent={agent}
              operator={auth.address!}
              refresh={refresh}
            />
          );
        })
      )}
    </>
  );
}
